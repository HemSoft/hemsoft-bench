import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {recoverSubmission,STARTER_SOURCE} from '../src/submission.mjs';
import {executionPolicy,isolatedPiSettings,summarizeRuns} from '../src/core.mjs';
import {normalizeOpenRouterFinishErrorResponse} from '../src/openrouter-retry.mjs';

test('Codex uses SSE with bounded agent recovery and no hidden provider retries',()=>{
  const model={provider:'openai-codex'};
  assert.equal(executionPolicy(model).transport,'sse');
  const settings=isolatedPiSettings(model);
  assert.equal(settings.transport,'sse');
  assert.equal(settings.retry.enabled,true);
  assert.equal(settings.retry.maxRetries,2);
  assert.equal(executionPolicy(model).version,4);
  assert.equal(executionPolicy(model).retryScope,'consecutive-errors');
  assert.equal(executionPolicy(model).openRouterFinishErrorRetry,true);
  assert.equal(settings.retry.provider.maxRetries,0);
  assert.equal(isolatedPiSettings({provider:'opencode-go'}).transport,'auto');
});

test('OpenRouter generic finish errors enter Pi retry without losing SSE error details',async()=>{
  const payload='data: '+JSON.stringify({error:{code:502,message:'upstream failed'},choices:[{delta:{},finish_reason:'error'}]})+'\n\ndata: [DONE]\n\n';
  const bytes=new TextEncoder().encode(payload);let normalized=0;
  const source=new ReadableStream({start(controller){controller.enqueue(bytes.subarray(0,31));controller.enqueue(bytes.subarray(31));controller.close();}});
  const response=new Response(source,{status:200,headers:{'content-type':'text/event-stream'}});
  const result=normalizeOpenRouterFinishErrorResponse('https://openrouter.ai/api/v1/chat/completions',response,()=>normalized++);
  const text=await result.text();
  assert.equal(normalized,1);
  assert.match(text,/"finish_reason":"network_error"/);
  assert.match(text,/"message":"upstream failed"/);
  assert.doesNotMatch(text,/"finish_reason":"error"/);
  assert.equal(normalizeOpenRouterFinishErrorResponse('https://openrouter.ai/api/v1/responses',response),response);
});

test('recovery copies bytes and removes the candidate before grading',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'hb-capture-'));
  const steps=[];
  try {
    const sandbox={submission:async()=>{steps.push('capture');return 'print([])';},dispose:async()=>steps.push('dispose')};
    const r=await recoverSubmission(sandbox,directory,async source=>{steps.push('grade');assert.equal(source,'print([])');return {passed:2,total:2,success:true};},'provider_error');
    assert.deepEqual(steps,['capture','dispose','grade']);
    assert.equal(r.state,'graded');
    assert.equal(r.reason,'provider_error');
    assert.equal(await readFile(join(directory,'submission.py'),'utf8'),'print([])');
    const [summary]=summarizeRuns([{task:'t',status:'provider_error',recovery:r}]);
    assert.equal(summary.fullPasses,0);
    assert.equal(summary.recoveredFullPasses,1);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('unchanged starter, missing file, and cleanup failure never trigger grading',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'hb-capture-'));
  try {
    const grade=()=>{throw new Error('grader must not run');};
    const unchanged=await recoverSubmission({submission:async()=>STARTER_SOURCE},directory,grade,'timeout');
    assert.equal(unchanged.state,'unchanged_starter');
    const custom=await recoverSubmission({submission:async()=>"custom starter"},directory,grade,'timeout',"custom starter");
    assert.equal(custom.state,'unchanged_starter');
    const missing=await recoverSubmission({submission:async()=>{throw new Error('missing');}},directory,grade,'timeout');
    assert.equal(missing.state,'capture_failed');
    const cleanup=await recoverSubmission({submission:async()=>'',dispose:async()=>{throw new Error('Docker unavailable');}},directory,grade,'timeout');
    assert.equal(cleanup.state,'cleanup_failed');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('grading failure retains the captured artifact and original stop reason',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'hb-capture-'));
  try {
    const r=await recoverSubmission({submission:async()=> 'broken python',dispose:async()=>{}},directory,async()=>{throw new Error('grader unavailable');},'timeout');
    assert.equal(r.state,'grading_failed');
    assert.equal(r.reason,'timeout');
    assert.equal(await readFile(join(directory,r.sourceFile),'utf8'),'broken python');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('changed transport policies cannot be pooled in reports',()=>{
  const base={task:'t',status:'passed'};
  assert.equal(summarizeRuns([base,{...base,executionPolicy:executionPolicy({provider:'openai-codex'})}]).length,2);
});
