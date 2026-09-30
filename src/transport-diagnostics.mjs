import {appendFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {threadId} from 'node:worker_threads';

export const TRACE_LIMIT=2*1024*1024;
const FRAME_LIMIT=64*1024;
const cappedPaths=new Set();
const instrumented=new WeakSet();
export function installTransportDiagnostics() {
 if(!process.env.HB_TRANSPORT_TRACE||typeof globalThis.fetch!=='function'||instrumented.has(globalThis.fetch))return;
 // Pi installs its own Undici fetch during startup. Wrap that implementation
 // after startup, not Node's earlier global fetch, and preserve its dispatcher.
 globalThis.fetch=diagnosticFetch(globalThis.fetch);
 instrumented.add(globalThis.fetch);
 recordDiagnostic('capture_installed',{coverage:'fetch HTTP/SSE; no raw TCP or WebSocket capture'});
}
const finishes=new Set(['stop','length','tool_calls','function_call','content_filter','network_error']);
const terminals=new Set(['response.completed','response.failed','response.incomplete','message_stop']);
const codes=new Set(['ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','ABORT_ERR']);

// Metadata only. No URLs, request/response bodies, exception messages, or raw headers.
// Failure to collect diagnostics must not interrupt inference or trigger a retry.
export function recordDiagnostic(event,fields={},path=process.env.HB_TRANSPORT_TRACE) {
 if(!path||cappedPaths.has(path))return;
 try {
  let size=0;try{size=statSync(path).size;}catch(e){if(e.code!=='ENOENT')throw e;}
  const line=JSON.stringify({version:1,at:new Date().toISOString(),pid:process.pid,threadId,event,...fields})+'\n';
  if(size>=TRACE_LIMIT)return;
  if(size+Buffer.byteLength(line)>TRACE_LIMIT-1024){
   cappedPaths.add(path);
   const notice=JSON.stringify({event:'capture_limit',at:new Date().toISOString()})+'\n';
   if(size+Buffer.byteLength(notice)<=TRACE_LIMIT)appendFileSync(path,notice);
   return;
  }
  appendFileSync(path,line);
 }catch{ /* Read-side reporting treats absent/incomplete traces as unknown. */ }
}

export function errorMetadata(error) {
 return {errorName:['AbortError','TimeoutError','TypeError'].includes(error?.name)?error.name:'other',errorCode:codes.has(error?.code)?error.code:codes.has(error?.cause?.code)?error.cause.code:null};
}
export function adapterErrorClass(message) {
 if(message==='Stream ended without finish_reason')return 'missing_finish_reason';
 if(typeof message==='string'&&/websocket/i.test(message))return 'websocket_error';
 return message?'other':null;
}

export class StreamFacts {
 constructor(now=()=>performance.now()) {
  this.now=now;this.started=now();this.bytes=0;this.chunks=0;this.firstByteMs=null;this.lastByteMs=null;this.maxGapMs=0;
  this.frames=0;this.invalidFrames=0;this.oversizedFrames=0;this.protocol='unknown';this.finishReasons=new Set();this.terminalEvents=new Set();this.done=false;this.usageSeen=false;this.errorEventSeen=false;
  this.deltaFrames={text:0,reasoning:0,tools:0};this.lastContentKinds=[];this.decoder=new TextDecoder();this.hash=createHash('sha256');
  this.line='';this.data=[];this.frameChars=0;this.drop=false;this.skipLF=false;this.eventName='';
 }
 consume(bytes) {
  const elapsed=this.now()-this.started;
  this.maxGapMs=Math.max(this.maxGapMs,elapsed-(this.lastByteMs??0));
  this.firstByteMs??=elapsed;this.lastByteMs=elapsed;this.bytes+=bytes.byteLength;this.chunks++;this.hash.update(bytes);
  for(let i=0;i<bytes.byteLength;i+=4096)this.text(this.decoder.decode(bytes.subarray(i,i+4096),{stream:true}));
 }
 text(text) {
  for(const c of text){
   if(this.skipLF){this.skipLF=false;if(c==='\n')continue;}
   if(c==='\r'||c==='\n'){this.onLine(this.line);this.line='';this.skipLF=c==='\r';}
   else if(this.line.length<FRAME_LIMIT)this.line+=c;
   else this.drop=true;
  }
 }
 onLine(line) {
  if(line===''){
   if(this.drop)this.oversizedFrames++;
   else if(this.data.length)this.frame(this.data.join('\n'));
   this.data=[];this.frameChars=0;this.drop=false;this.eventName='';return;
  }
  if(line.startsWith('event:'))this.eventName=line.slice(6).trim();
  if(line.startsWith('data:')){
   const value=line.slice(5).replace(/^ /,'');this.frameChars+=value.length+1;
   if(this.frameChars>FRAME_LIMIT)this.drop=true;
   if(!this.drop)this.data.push(value);
  }
 }
 frame(data) {
  this.frames++;
  // OpenAI's consumer stops at [DONE]; later bytes cannot prove an adapter bug.
  if(this.done)return;
  if(data.startsWith('[DONE]')){this.done=true;return;}
  let obj;try{obj=JSON.parse(data);}catch{this.invalidFrames++;return;}
  if(!obj||typeof obj!=='object')return;
  if(obj.error||this.eventName==='error')this.errorEventSeen=true;
  if(obj.usage&&typeof obj.usage==='object')this.usageSeen=true;
  if(Array.isArray(obj.choices)){
   this.protocol='chat-completions';const choice=obj.choices[0];
   if(choice?.finish_reason)this.finishReasons.add(finishes.has(choice.finish_reason)?choice.finish_reason:'other');
   if(choice?.usage&&typeof choice.usage==='object')this.usageSeen=true;
   const d=choice?.delta,kinds=[];
   if(d?.content){this.deltaFrames.text++;kinds.push('text');}
   if(d?.reasoning_content||d?.reasoning||d?.thinking){this.deltaFrames.reasoning++;kinds.push('reasoning');}
   if(d?.tool_calls||d?.function_call){this.deltaFrames.tools++;kinds.push('tools');}
   if(kinds.length)this.lastContentKinds=kinds;
  }
  if(typeof obj.type==='string'&&obj.type.startsWith('response.'))this.protocol='responses';
  if(['message_start','message_delta','message_stop'].includes(obj.type))this.protocol='anthropic';
  if(terminals.has(obj.type))this.terminalEvents.add(obj.type);
  if(terminals.has(this.eventName))this.terminalEvents.add(this.eventName);
 }
 snapshot() {
  const elapsedMs=Math.round(this.now()-this.started);
  return {elapsedMs,bytes:this.bytes,chunks:this.chunks,firstByteMs:this.firstByteMs===null?null:Math.round(this.firstByteMs),lastByteMs:this.lastByteMs===null?null:Math.round(this.lastByteMs),maxReadGapMs:Math.round(Math.max(this.maxGapMs,elapsedMs-(this.lastByteMs??0))),frames:this.frames,invalidFrames:this.invalidFrames,oversizedFrames:this.oversizedFrames,protocol:this.protocol,finishReasons:[...this.finishReasons],terminalEvents:[...this.terminalEvents],done:this.done,usageSeen:this.usageSeen,errorEventSeen:this.errorEventSeen,deltaFrames:{...this.deltaFrames},lastContentKinds:[...this.lastContentKinds],pendingFrame:!!(this.line||this.data.length||this.drop),consumedBodySha256:this.hash.copy().digest('hex')};
 }
}

function routeKind(input) {
 try{
  const path=new URL(typeof input==='string'||input instanceof URL?String(input):input.url).pathname;
  if(path.endsWith('/chat/completions'))return 'chat-completions';
  if(path.endsWith('/responses'))return 'responses';
  if(path.endsWith('/messages'))return 'messages';
 }catch{}
 return 'other';
}

export function diagnosticFetch(original,emit=recordDiagnostic) {
 let sequence=0;
 return async function(input,init){
  const fetchId=`${process.pid}:${threadId}:${++sequence}`;
  const n=Number(process.env.HB_PROVIDER_REQUEST),request=Number.isSafeInteger(n)&&n>0?n:null;
  const kind=routeKind(input),started=performance.now();let tracked=kind!=='other';
  const signal=init?.signal??input?.signal;
  const base={fetchId,request,kind};
  const safeEmit=(event,data={})=>{try{emit(event,{...base,...data});}catch{}};
  if(tracked)safeEmit('transport_start');
  let response;
  try{response=await original.call(globalThis,input,init);}
  catch(error){if(tracked)safeEmit('transport_end',{end:'fetch_error',elapsedMs:Math.round(performance.now()-started),signalAborted:!!signal?.aborted,...errorMetadata(error)});throw error;}
  const sse=/^text\/event-stream\s*(?:;|$)/i.test(response.headers.get('content-type')??'');
  if(!tracked&&!sse)return response;
  if(!tracked){tracked=true;safeEmit('transport_start');}
  const id=response.headers.get('x-request-id')??response.headers.get('request-id')??response.headers.get('cf-ray');
  safeEmit('transport_headers',{status:response.status,sse,headersMs:Math.round(performance.now()-started),requestIdHash:id?createHash('sha256').update(id).digest('hex'):null});
  if(!sse||!response.body){safeEmit('transport_end',{end:response.ok?'non_sse':'http_error',status:response.status,elapsedMs:Math.round(performance.now()-started)});return response;}
  const facts=new StreamFacts();facts.started=started;
  const reader=response.body.getReader();let ended=false,lastSnapshot=0;
  const finish=(end,error)=>{
   if(ended)return;ended=true;
   safeEmit('transport_end',{...facts.snapshot(),end,signalAborted:!!signal?.aborted,abortReasonName:signal?.aborted?errorMetadata(signal.reason).errorName:null,...(error?errorMetadata(error):{})});
  };
  const body=new ReadableStream({
   async pull(controller){
    try{
     const chunk=await reader.read();
     if(chunk.done){finish('eof');controller.close();return;}
     try{
      facts.consume(chunk.value);
      if(facts.chunks===1||performance.now()-lastSnapshot>=5000){lastSnapshot=performance.now();safeEmit('transport_progress',facts.snapshot());}
     }catch{safeEmit('inspection_error');}
     controller.enqueue(chunk.value);
    }catch(error){finish('read_error',error);controller.error(error);}
   },
   cancel(reason){finish('consumer_cancel');return reader.cancel(reason).catch(error=>{safeEmit('cancel_error',errorMetadata(error));throw error;});}
  },{highWaterMark:0});
  const wrapped=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
  for(const key of ['url','redirected','type'])Object.defineProperty(wrapped,key,{value:response[key]});
  return wrapped;
 };
}

export function summarizeDiagnostics(records) {
 const requests=new Map();const adapters=new Map();const allowed=new Set();
 let limited=false;
 for(const e of records){
  if(e.event==='capture_limit'||e.event==='inspection_error')limited=true;
  if(e.event==='provider_request_allowed')allowed.add(e.request);
  if(e.event==='adapter_end')adapters.set(e.request,e);
  if(!e.fetchId)continue;
  const r=requests.get(e.fetchId)??{fetchId:e.fetchId,request:e.request,kind:e.kind};
  if(e.event==='transport_headers')Object.assign(r,{status:e.status,sse:e.sse,headersMs:e.headersMs,requestIdHash:e.requestIdHash});
  if(['transport_progress','transport_end'].includes(e.event))Object.assign(r,e);
  if(e.event==='cancel_error')Object.assign(r,{cancelError:true,cancelErrorCode:e.errorCode});
  requests.set(e.fetchId,r);
 }
 return {captureLimited:limited,blocked:records.filter(e=>e.event==='request_blocked').map(e=>({at:e.at,reason:e.reason})),adapterResponses:records.filter(e=>e.event==='adapter_end').length,allowedRequests:allowed.size,unobservedRequests:[...allowed].filter(n=>![...requests.values()].some(r=>r.request===n)),requests:[...requests.values()].map(r=>{
  const adapter=adapters.get(r.request);let condition='unknown';
  if(r.status>=400)condition='http_error';
  else if(r.end==='fetch_error')condition='fetch_failed';
  else if(r.end==='http_error')condition='http_error';
  else if(r.signalAborted)condition='fetch_signal_aborted';
  else if(r.end==='read_error'&&r.errorName==='AbortError')condition=adapter?.errorClass==='missing_finish_reason'?'body_abort_masked_as_missing_finish':'fetch_body_abort';
  else if(r.end==='read_error')condition='stream_read_failed';
  else if(r.cancelError)condition='consumer_cancel_failed';
  else if(r.end==='non_sse')condition='non_sse_content_type';
  else if(!r.end)condition='no_transport_end_record';
  else if(r.invalidFrames||r.oversizedFrames||r.pendingFrame||limited)condition='inspection_incomplete';
  else if(r.errorEventSeen||r.finishReasons?.some(reason=>['content_filter','network_error','other'].includes(reason))||r.terminalEvents?.some(e=>['response.failed','response.incomplete'].includes(e)))condition='provider_error_event';
  else if(r.finishReasons?.length||r.terminalEvents?.length)condition=adapter?.errorClass==='missing_finish_reason'?'finish_marker_adapter_disagreement':'completion_marker_observed';
  else if(r.protocol==='chat-completions'&&r.done)condition='done_without_finish_reason';
  else if(r.protocol==='chat-completions'&&r.end==='eof')condition='eof_without_finish_reason';
  else if(r.end==='consumer_cancel')condition='consumer_cancelled_without_completion_marker';
  return {...r,condition,adapterStop:adapter?.stopReason??null,adapterErrorClass:adapter?.errorClass??null};
 })};
}
