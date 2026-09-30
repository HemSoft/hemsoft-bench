import test from 'node:test';
import assert from 'node:assert/strict';
import {run} from '../src/process.mjs';

test('stop observer runs once and cannot replace the original stop reason',async()=>{
 const abort=new AbortController(),stops=[];
 const r=await run(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:100,signal:abort.signal,onStop:reason=>{stops.push(reason);abort.abort();}});
 assert.deepEqual(stops,['timeout']);assert.equal(r.failure,'timeout');
});
test('a failed stop observer still terminates the process',async()=>{
 const r=await run(process.execPath,['-e','setInterval(()=>{},1000)'],{timeoutMs:100,onStop:()=>{throw new Error('stop marker write failed');}});
 assert.equal(r.failure,'timeout');assert.equal(r.observerError,'stop marker write failed');
});
