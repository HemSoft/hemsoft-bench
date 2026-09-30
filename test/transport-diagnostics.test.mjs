import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {diagnoseStream} from '../src/diagnose-stream.mjs';
import {StreamFacts,diagnosticFetch,summarizeDiagnostics,recordDiagnostic,TRACE_LIMIT} from '../src/transport-diagnostics.mjs';

const frame=obj=>'data: '+JSON.stringify(obj)+'\r\n\r\n';
const delta=frame({choices:[{delta:{content:'private Ω 🦊 finish_reason: stop'}}]});
const finish=frame({choices:[{finish_reason:'stop',delta:{}}]});
const done='data: [DONE]\r\n\r\n';
const bytes=s=>new TextEncoder().encode(s);
function facts(text){const f=new StreamFacts();for(const b of bytes(text))f.consume(Uint8Array.of(b));return f.snapshot();}

test('byte-split UTF-8 and CRLF preserve markers without collecting content',()=>{
 const f=facts(delta+finish+done);
 assert.equal(f.frames,3);assert.equal(f.done,true);assert.deepEqual(f.finishReasons,['stop']);
 assert.equal(f.pendingFrame,false);assert.equal(f.invalidFrames,0);assert.equal(f.deltaFrames.text,1);
 assert.ok(!JSON.stringify(f).includes('private'));
});
test('normal EOF and DONE without finish_reason are distinguishable',()=>{
 for(const [text,condition] of [[delta,'eof_without_finish_reason'],[delta+done,'done_without_finish_reason']]){
  const s=summarizeDiagnostics([{event:'transport_end',fetchId:'1',request:1,end:'eof',...facts(text)}]);
  assert.equal(s.requests[0].condition,condition);
 }
});
test('markers after DONE do not falsely implicate the adapter',()=>{
 assert.deepEqual(facts(delta+done+finish).finishReasons,[]);
});
test('malformed, oversized and partial SSE frames remain uncertain',()=>{
 for(const text of ['data: invalid\n\n','data: '+JSON.stringify({text:'x'.repeat(70000)})+'\n\n','data: {"choices":']){
  const f=facts(text);assert.ok(f.invalidFrames||f.oversizedFrames||f.pendingFrame);
  assert.equal(summarizeDiagnostics([{event:'transport_end',fetchId:'1',end:'eof',...f}]).requests[0].condition,'inspection_incomplete');
 }
});
test('a valid finish marker plus the exact adapter error exposes disagreement',()=>{
 const s=summarizeDiagnostics([{event:'transport_end',fetchId:'1',request:1,end:'eof',...facts(delta+finish+done)},{event:'adapter_end',request:1,stopReason:'error',errorClass:'missing_finish_reason'}]);
 assert.equal(s.requests[0].condition,'finish_marker_adapter_disagreement');
});
test('stream wrapper is pull-driven and preserves bytes and response properties',async()=>{
 const rows=[];let pulls=0;
 const response=new Response(new ReadableStream({pull(c){pulls++;c.enqueue(bytes(delta+finish+done));c.close();}},{highWaterMark:0}),{headers:{'content-type':'text/event-stream','x-request-id':'private-id','set-cookie':'private-cookie'}});
 Object.defineProperty(response,'url',{value:'https://example.invalid/chat/completions?secret=private-url'});
 const fetch=diagnosticFetch(async()=>response,(event,data)=>rows.push({event,...data}));
 const wrapped=await fetch('https://user:private-password@example.invalid/chat/completions?key=private-url',{headers:{Authorization:'Bearer private-token'}});
 assert.equal(pulls,0);assert.equal(wrapped.url,response.url);assert.equal(wrapped.headers.get('set-cookie'),'private-cookie');
 assert.equal(await wrapped.text(),delta+finish+done);assert.equal(pulls,1);
 const text=JSON.stringify(rows);for(const secret of ['private-id','private-cookie','private-url','private-token','private-password','private Ω'])assert.ok(!text.includes(secret),secret);
 assert.equal(rows.at(-1).end,'eof');assert.equal(rows.at(-1).done,true);
});
test('read errors retain their identity and never log exception messages',async()=>{
 const error=Object.assign(new TypeError('private network URL'),{cause:{code:'UND_ERR_SOCKET'}}),rows=[];
 const fetch=diagnosticFetch(async()=>new Response(new ReadableStream({pull(c){c.error(error);}}),{headers:{'content-type':'text/event-stream'}}),(event,data)=>rows.push({event,...data}));
 const r=await fetch('https://example.invalid/chat/completions');
 await assert.rejects(r.text(),e=>e===error);
 assert.equal(rows.at(-1).end,'read_error');assert.equal(rows.at(-1).errorCode,'UND_ERR_SOCKET');
 assert.ok(!JSON.stringify(rows).includes('private network'));
});
test('consumer cancellation and abort signal are reported, not converted to EOF',async()=>{
 const abort=new AbortController(),rows=[];let cancelled=false;
 const fetch=diagnosticFetch(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}},{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}}),(event,data)=>rows.push({event,...data}));
 const r=await fetch('https://example.invalid/chat/completions',{signal:abort.signal});abort.abort('private reason');await r.body.cancel('private reason');
 assert.equal(cancelled,true);assert.equal(rows.at(-1).end,'consumer_cancel');assert.equal(rows.at(-1).signalAborted,true);
 assert.ok(!JSON.stringify(rows).includes('private reason'));
});
test('non-SSE error bodies are never consumed by diagnostics',async()=>{
 const response=new Response('private body',{status:429}),rows=[];
 const r=await diagnosticFetch(async()=>response,(event,data)=>rows.push({event,...data}))('https://example.invalid/chat/completions');
 assert.equal(r,response);assert.equal(r.bodyUsed,false);assert.equal(rows.at(-1).end,'http_error');assert.ok(!JSON.stringify(rows).includes('private body'));
});
test('failed diagnostic writers do not change the response',async()=>{
 const f=diagnosticFetch(async()=>new Response(delta+finish+done,{headers:{'content-type':'text/event-stream'}}),()=>{throw new Error('disk full');});
 assert.equal(await (await f('https://example.invalid/chat/completions')).text(),delta+finish+done);
});
test('trace output is capped and identifies its loss of coverage',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hb-trace-')),file=join(dir,'trace.jsonl');
 try{
  await writeFile(file,' '.repeat(TRACE_LIMIT-1100));
  for(let i=0;i<20;i++)recordDiagnostic('bounded',{counter:i},file);
  assert.ok((await stat(file)).size<=TRACE_LIMIT);
  assert.ok((await readFile(file,'utf8')).includes('capture_limit'));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Responses completion and failure markers are distinct',()=>{
 for(const [type,condition] of [['response.completed','completion_marker_observed'],['response.failed','provider_error_event']]){
  const s=summarizeDiagnostics([{event:'transport_end',fetchId:'1',end:'eof',...facts(frame({type}))}]);
  assert.equal(s.requests[0].condition,condition);
 }
});
test('fetch failures preserve errors while excluding URLs and messages',async()=>{
 const error=Object.assign(new TypeError('private proxy credential'),{cause:{code:'ECONNRESET'}}),rows=[];
 const fetch=diagnosticFetch(async()=>{throw error;},(event,data)=>rows.push({event,...data}));
 await assert.rejects(fetch('https://example.invalid/chat/completions'),e=>e===error);
 assert.equal(rows.at(-1).end,'fetch_error');assert.equal(rows.at(-1).errorCode,'ECONNRESET');
 assert.ok(!JSON.stringify(rows).includes('private proxy'));
});
test('timing measures consumption gaps rather than claiming packet arrival times',()=>{
 let now=0;const f=new StreamFacts(()=>now);
 now=5;f.consume(bytes(delta));now=50;f.consume(bytes(finish));now=100;
 const s=f.snapshot();assert.equal(s.firstByteMs,5);assert.equal(s.lastByteMs,50);assert.equal(s.maxReadGapMs,50);
 assert.deepEqual(s.lastContentKinds,['text']);
});
test('diagnostic reader reports missing and damaged evidence explicitly',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hb-diagnose-')),file=join(dir,'result.json');
 try{
  await writeFile(file,JSON.stringify({status:'timeout',metrics:{assistantTurns:1}}));
  assert.equal((await diagnoseStream(file)).available,false);
  await writeFile(join(dir,'transport.jsonl'),JSON.stringify({event:'capture_installed'})+'\nnull\npartial');
  const report=await diagnoseStream(file);
  assert.equal(report.available,true);assert.equal(report.runStop,'timeout');assert.equal(report.malformedRecords,2);
  assert.equal(report.captureLimited,true);assert.equal(report.missingAdapterRecords,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('consumer cancellation failures remain visible and propagate unchanged',async()=>{
 const error=new Error('private cancellation reason'),rows=[];
 const fetch=diagnosticFetch(async()=>new Response(new ReadableStream({cancel(){throw error;}},{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}}),(event,data)=>rows.push({event,...data}));
 const r=await fetch('https://example.invalid/chat/completions');
 await assert.rejects(r.body.cancel(),e=>e===error);
 assert.equal(summarizeDiagnostics(rows).requests[0].condition,'consumer_cancel_failed');
 assert.ok(!JSON.stringify(rows).includes('private cancellation'));
});
test('missing transport records are explicit, not evidence of a provider failure',()=>{
 const s=summarizeDiagnostics([{event:'provider_request_allowed',request:3}]);
 assert.deepEqual(s.unobservedRequests,[3]);assert.equal(s.requests.length,0);
});
