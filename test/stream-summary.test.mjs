import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeEvents} from '../src/core.mjs';
import {Activity} from '../src/activity.mjs';

const usage={input:10,output:5,cacheRead:0,cacheWrite:0,cost:{total:0.1}};
const end=(stopReason,errorMessage)=>({type:'message_end',message:{role:'assistant',stopReason,errorMessage,usage,content:[]}});

test('a completed retry is a completed answer, with incomplete accounting',()=>{
 const s=summarizeEvents([end('error','Stream ended without finish_reason'),{type:'auto_retry_start'},end('stop')]);
 assert.equal(s.completed,true);assert.deepEqual(s.providerErrors,[]);
 assert.deepEqual(s.recoveredProviderErrors,['Stream ended without finish_reason']);
 assert.equal(s.retryCount,1);assert.equal(s.usageComplete,false);assert.equal(s.estimatedCostUsd,null);
 assert.equal(s.reportedEstimatedCostUsd,0.2);
});
test('recovered errors stay separate when a later failure ends the run',()=>{
 const s=summarizeEvents([end('error','stream failed'),end('toolUse'),end('error','quota exceeded')]);
 assert.equal(s.completed,false);assert.deepEqual(s.recoveredProviderErrors,['stream failed']);
 assert.deepEqual(s.providerErrors,['quota exceeded']);
});
test('retry waits are visible without exposing provider text',()=>{
 const activity=new Activity(()=>1000);
 assert.equal(activity.accept({type:'auto_retry_start',errorMessage:'private text'}),true);
 assert.equal(activity.snapshot().phase,'Retrying response');
 assert.equal(activity.snapshot().retriesScheduled,1);
 assert.ok(!JSON.stringify(activity.snapshot()).includes('private text'));
 activity.accept({type:'auto_retry_end',success:true});
 assert.equal(activity.snapshot().phase,'Response recovered');
});
