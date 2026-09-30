const instrumented=new WeakSet();

function routeKind(input) {
 try {
  const path=new URL(typeof input==='string'||input instanceof URL?String(input):input.url).pathname;
  return path.endsWith('/chat/completions');
 } catch { return false; }
}

function rewriteLine(line,onNormalized) {
 const cr=line.endsWith('\r')?'\r':'';
 const body=cr?line.slice(0,-1):line;
 const match=/^(data:\s?)(.*)$/.exec(body);
 if(!match||match[2].startsWith('[DONE]'))return line;
 let value;
 try{value=JSON.parse(match[2]);}catch{return line;}
 const choices=Array.isArray(value?.choices)?value.choices:[];
 if(!choices.some(choice=>choice?.finish_reason==='error'))return line;
 for(const choice of choices)if(choice?.finish_reason==='error')choice.finish_reason='network_error';
 onNormalized?.();
 return match[1]+JSON.stringify(value)+cr;
}

export function normalizeOpenRouterFinishErrorResponse(input,response,onNormalized) {
 const sse=/^text\/event-stream\s*(?:;|$)/i.test(response?.headers?.get?.('content-type')??'');
 if(!routeKind(input)||response?.status!==200||!sse||!response.body)return response;
 const decoder=new TextDecoder(),encoder=new TextEncoder();let pending='';
 const body=response.body.pipeThrough(new TransformStream({
  transform(chunk,controller){
   pending+=decoder.decode(chunk,{stream:true});
   for(;;){
    const newline=pending.indexOf('\n');
    if(newline<0)break;
    const line=pending.slice(0,newline);pending=pending.slice(newline+1);
    controller.enqueue(encoder.encode(rewriteLine(line,onNormalized)+'\n'));
   }
  },
  flush(controller){
   pending+=decoder.decode();
   if(pending)controller.enqueue(encoder.encode(rewriteLine(pending,onNormalized)));
  }
 }));
 const wrapped=new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
 for(const key of ['url','redirected','type'])Object.defineProperty(wrapped,key,{value:response[key]});
 return wrapped;
}

export function installOpenRouterFinishErrorRetry(provider,onNormalized) {
 if(provider!=='openrouter'||typeof globalThis.fetch!=='function'||instrumented.has(globalThis.fetch))return;
 const original=globalThis.fetch;
 globalThis.fetch=async function(input,init){
  const response=await original.call(globalThis,input,init);
  return normalizeOpenRouterFinishErrorResponse(input,response,onNormalized);
 };
 instrumented.add(globalThis.fetch);
}
