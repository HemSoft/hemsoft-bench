import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {run} from '../src/process.mjs';
import {eventDecoder} from '../src/activity.mjs';
import {diagnoseStream} from '../src/diagnose-stream.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const scenarios=[
 {mode:'recover',status:'passed',requests:4,retries:1},
 {mode:'done_without_finish',status:'passed',requests:4,retries:1},
 {mode:'socket_reset',status:'passed',requests:4,retries:1},
 {mode:'finish_error',status:'passed',requests:4,retries:1},
 {mode:'exhausted',status:'provider_error',requests:4,retries:2},
 {mode:'request_limit',status:'request_limit',requests:2,retries:1,limits:['--max-requests','2']},
 {mode:'cost_limit',status:'estimated_cost_limit',requests:2,retries:1,limits:['--max-estimated-usd','0.01']},
 {mode:'timeout',status:'timeout',requests:2,retries:1,wall:5},
 {mode:'cancel',status:'aborted',requests:2,retries:1},
 {mode:'quota',status:'provider_error',requests:2,retries:0},
 {mode:'auth',status:'provider_error',requests:2,retries:0},
];

// Real installed Pi, its OpenCode/OpenAI streaming adapter, our extension, and
// Docker. Only the provider is replaced by loopback SSE. A fresh agent directory
// uses a dummy credential and never reads the operator's real authentication.
for(const scenario of scenarios)test(`real Pi stream recovery: ${scenario.mode}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'hb-stream-'));
 const id=randomUUID(),managed=join(root,'.local','managed-runs',id);
 const requests=[];const source=await readFile(join(root,'references','authority-ledger.py'),'utf8');
 const server=createServer(async(req,res)=>{
  let body='';for await(const c of req)body+=c;
  const request=JSON.parse(body);requests.push(request);
  if(requests.length===2&&['quota','auth'].includes(scenario.mode)){
   res.writeHead(scenario.mode==='quota'?429:401,{'Content-Type':'application/json'});
   res.end(JSON.stringify({error:{message:scenario.mode==='quota'?'GoUsageLimitError: Monthly usage limit reached':'Invalid API key',type:scenario.mode==='quota'?'GoUsageLimitError':'authentication_error'}}));return;
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  const chunk=(delta,finish=null)=>res.write('data: '+JSON.stringify({id:'offline-'+requests.length,object:'chat.completion.chunk',model:'kimi-k3',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');
  const usage=n=>res.write('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:n,completion_tokens:0,total_tokens:n}})+'\n\n');
  const tool=(id,name,args,finish=true)=>{chunk({role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});if(finish)chunk({},'tool_calls');};
  if(requests.length===1)tool('saved-code','sandbox_write',{path:'/workspace/solution.py',content:source});
  else if(requests.length===2||scenario.mode==='exhausted'){
   // A complete-looking tool call still must not execute without finish_reason.
   chunk({content:'INCOMPLETE_RESPONSE_MUST_NOT_BE_REPLAYED'});
   tool('partial-write','sandbox_write',{path:'/workspace/partial-marker.txt',content:'must not execute'},false);
   if(scenario.mode==='done_without_finish'){res.end('data: [DONE]\n\n');return;}
   if(scenario.mode==='socket_reset'){setTimeout(()=>res.destroy(),100);return;}
   if(scenario.mode==='finish_error'){chunk({},'error');usage(10);res.end('data: [DONE]\n\n');return;}
   if(scenario.mode==='cost_limit')usage(1000000);
   if(scenario.mode==='timeout')await new Promise(resolve=>setTimeout(resolve,3000));
   res.end();return;
  }else if(requests.length===3)tool('check-sandbox','sandbox_bash',{command:'test -s /workspace/solution.py && test ! -e /workspace/partial-marker.txt && echo preserved'});
  else chunk({content:'Finished.'},'stop');
  usage(scenario.mode==='cost_limit'?0:10);res.end('data: [DONE]\n\n');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const agent=join(dir,'agent');await mkdir(agent);await writeFile(join(agent,'auth.json'),'{}');
  const provider=scenario.mode==='finish_error'?'openrouter':'opencode-go';
  const model=scenario.mode==='finish_error'?'moonshotai/kimi-k3':'kimi-k3';
  await writeFile(join(agent,'models.json'),JSON.stringify({providers:{[provider]:{baseUrl:`http://127.0.0.1:${server.address().port}/v1`,api:'openai-completions',apiKey:'offline-fixture-not-a-real-key',modelOverrides:{[model]:{cost:{input:1,output:1,cacheRead:1,cacheWrite:1}}}}}}));
  const config=join(dir,'config.json');await writeFile(config,JSON.stringify({model:{provider,model,thinking:'max'}}));
  const decoder=eventDecoder(event=>{
   if(scenario.mode==='cancel'&&event.type==='progress'&&event.activity?.phase==='Retrying response')writeFileSync(join(managed,'cancel'),'offline-test');
  });
  const execution=await run(process.execPath,[join(root,'src','cli.mjs'),'run','authority-ledger','--config',config,'--managed-run',id,'--repeat','1','--wall-seconds',String(scenario.wall??30),...(scenario.limits??[]),'--execute','--progress-json'],{env:{...process.env,PI_CODING_AGENT_DIR:agent},timeoutMs:50000,onStdout:chunk=>decoder.push(chunk)});
  decoder.end();
  const event=JSON.parse(execution.stdout.trim().split('\n').at(-1));
  const result=JSON.parse(await readFile(event.resultFile,'utf8'));
  assert.equal(result.status,scenario.status,JSON.stringify({status:result.status,error:result.error,stderr:execution.stderr}));
  assert.equal(requests.length,scenario.requests);
  assert.equal(result.metrics.retryCount,scenario.retries);
  assert.equal(result.model.thinking,'max');
  assert.ok(requests.every(request=>request.model===model));
  assert.equal(result.metrics.usageComplete,false,'lost stream usage cannot become complete after retry');
  assert.equal(result.metrics.estimatedCostUsd,null);
  if(scenario.mode==='cost_limit')assert.equal(result.metrics.reportedEstimatedCostUsd,1);
  const events=(await readFile(join(event.resultFile,'..','events.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e=>e.type==='tool_execution_start'&&e.toolName==='sandbox_write').length,1,'executed an incomplete or duplicate tool call');
  const diagnosis=await diagnoseStream(event.resultFile);
  assert.equal(diagnosis.available,true);
  assert.deepEqual(diagnosis.unobservedRequests,[]);
  assert.equal(diagnosis.requests.length,requests.length);
  if(scenario.status==='passed'){
   assert.equal(result.grade.passed,60);
   const failure=diagnosis.requests.find(r=>r.request===2);
   const expected={recover:'eof_without_finish_reason',done_without_finish:'done_without_finish_reason',socket_reset:'stream_read_failed',finish_error:'provider_error_event'}[scenario.mode];
   assert.equal(failure.condition,expected,JSON.stringify(failure));
   assert.equal(failure.status,200);
   assert.equal(failure.adapterStop,'error');
   if(scenario.mode==='finish_error')assert.deepEqual(failure.finishReasons,['other']);
   else assert.ok(!failure.finishReasons.length);
   assert.ok(diagnosis.requests.some(r=>r.condition==='completion_marker_observed'));
   assert.deepEqual(requests[2].messages,requests[1].messages,'retry did not preserve the prior conversation checkpoint');
   assert.ok(JSON.stringify(requests[2].messages).includes('saved-code'),'completed tool history was lost');
   assert.ok(!JSON.stringify(requests[2].messages).includes('INCOMPLETE_RESPONSE_MUST_NOT_BE_REPLAYED'));
   assert.ok(events.some(e=>e.type==='tool_execution_end'&&JSON.stringify(e.result).includes('preserved')),'sandbox did not survive');
   assert.deepEqual(result.metrics.providerErrors,[]);
   if(scenario.mode==='finish_error')assert.deepEqual(result.metrics.recoveredProviderErrors,['Provider finish_reason: network_error']);
   else if(scenario.mode!=='socket_reset')assert.deepEqual(result.metrics.recoveredProviderErrors,['Stream ended without finish_reason']);
   else assert.equal(result.metrics.recoveredProviderErrors.length,1);
  }else{
   assert.equal(result.grade,null);
   assert.equal(result.recovery.grade.passed,60,'existing code was not retained after exhausted recovery');
  }
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});await rm(managed,{recursive:true,force:true});}
});
