import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {piCommand} from '../src/process.mjs';
import {diagnosticFetch,summarizeDiagnostics,adapterErrorClass} from '../src/transport-diagnostics.mjs';

const pi=piCommand();
test('actual Pi adapter can report missing finish_reason when its SDK swallows a body AbortError',{skip:!pi.prefix.length,timeout:10000},async()=>{
 const path=resolve(dirname(pi.prefix[0]),'../../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js');
 const {stream}=await import(pathToFileURL(path));
 const model={id:'kimi-k3',provider:'opencode-go',api:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',reasoning:true,input:['text'],cost:{input:1,output:1,cacheRead:1,cacheWrite:1},contextWindow:32000,maxTokens:4096};
 const rows=[];let calls=0;
 const fetch=diagnosticFetch(async()=>{
  calls++;let delivered=false;
  return new Response(new ReadableStream({pull(c){
   if(!delivered){delivered=true;c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:null}]})+'\n\n'));}
   else c.error(new DOMException('private abort details','AbortError'));
  }},{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}});
 },(event,data)=>rows.push({event,...data}));
 // Explicit fake fetch and an unusable loopback endpoint. No real auth or network.
 const result=await stream(model,{messages:[{role:'user',content:'fixture',timestamp:Date.now()}]},{apiKey:'offline-fixture',maxRetries:0,fetch}).result();
 assert.equal(calls,1);assert.equal(result.stopReason,'error');
 assert.equal(result.errorMessage,'Stream ended without finish_reason');
 const failure=rows.find(e=>e.event==='transport_end');
 assert.equal(failure.end,'read_error');assert.equal(failure.errorName,'AbortError');
 assert.equal(failure.signalAborted,false);
 rows.push({event:'adapter_end',request:failure.request,stopReason:result.stopReason,errorClass:adapterErrorClass(result.errorMessage)});
 assert.equal(summarizeDiagnostics(rows).requests[0].condition,'body_abort_masked_as_missing_finish');
 assert.ok(!JSON.stringify(rows).includes('private abort details'));
});
