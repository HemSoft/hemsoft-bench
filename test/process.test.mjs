import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run} from '../src/process.mjs';
import {mkdtempSync, appendFileSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {eventDecoder, Activity} from '../src/activity.mjs';

test('process runner preserves arguments literally and returns exit status',async()=>{
  const arg='$(echo unsafe); & | "quoted"';
  const result=await run(process.execPath,['-e','process.stdout.write(process.argv[1]);process.stderr.write("error");process.exitCode=7',arg]);
  assert.equal(result.stdout,arg);assert.equal(result.stderr,'error');assert.equal(result.code,7);
});
test('process runner bounds output',async()=>{
  const result=await run(process.execPath,['-e','setInterval(()=>process.stdout.write("x".repeat(65536)),1)'],{maxBytes:1024,timeoutMs:10000});
  assert.equal(result.failure,'output_limit');assert.ok(result.stdout.length<=1024);
});
test('process runner terminates a timed-out process',async()=>{
  const result=await run(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:300});
  assert.equal(result.failure,'timeout');
});
test('process runner can disable its timer for uncapped grading',async()=>{
  const result=await run(process.execPath,['-e','setTimeout(()=>process.stdout.write("done"),50)'],{timeoutMs:null});
  assert.equal(result.failure,null);assert.equal(result.stdout,'done');
});
test('output is observed and persisted before the child exits',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'hb-live-test-'));
  const ack=join(directory,'ack'), log=join(directory,'events.jsonl');
  const activity=new Activity();
  const decoder=eventDecoder(event=>{activity.accept(event);writeFileSync(ack,'observed');});
  try {
    const result=await run(process.execPath,['-e',`const fs=require('node:fs');process.stdout.write(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'private'}})+'\\n');process.stderr.write('diagnostic');setInterval(()=>{if(fs.existsSync(process.argv[1]))process.exit(0)},20);`,ack],{
      timeoutMs:5000,
      onStdout:chunk=>{appendFileSync(log,chunk);decoder.push(chunk);},
      onStderr:chunk=>appendFileSync(join(directory,'stderr.txt'),chunk),
    });
    assert.equal(result.failure,null);
    assert.equal(activity.snapshot().deltas,1);
    assert.equal(readFileSync(log,'utf8'),result.stdout);
    assert.equal(readFileSync(join(directory,'stderr.txt'),'utf8'),'diagnostic');
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('observer failures stop the child rather than throwing from an event callback',async()=>{
  const result=await run(process.execPath,['-e','process.stdout.write("x");setInterval(()=>{},1000)'],{onStdout:()=>{throw new Error('disk full');}});
  assert.equal(result.failure,'output_observer_error');
  assert.equal(result.observerError,'disk full');
});

test('process runner does not launch on an already aborted signal',async()=>{
  const c=new AbortController();c.abort();
  await assert.rejects(run(process.execPath,['-e','process.exit(0)'],{signal:c.signal}),/aborted/);
});
