import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { run } from '../src/process.mjs';
import { eventDecoder } from '../src/activity.mjs';

const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
const config=fileURLToPath(new URL('../run.json',import.meta.url));
const managed=id=>fileURLToPath(new URL(`../.local/managed-runs/${id}/`,import.meta.url));
const legacy=fileURLToPath(new URL('../.local/run-lock/owner.json',import.meta.url));

test('managed namespaces run concurrently and cancellation cleans only its own sandbox', async () => {
  const directory=await mkdtemp(join(tmpdir(),'hb-managed-fixture-'));
  const entry=join(directory,'fake-pi.cjs');
  const ids=[randomUUID(),randomUUID()];
  const previousLegacy=await readFile(legacy,'utf8').catch(()=>null);
  const source=`
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('offline-fixture');process.exit(0)}
const spec=JSON.parse(fs.readFileSync(process.env.HB_RUN_SPEC,'utf8'));
fs.writeFileSync(spec.statePath,JSON.stringify({status:spec.selfTest?'self_test_passed':'ready'}));
console.log(JSON.stringify({type:'message_start',message:{role:'assistant'}}));
console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'fixture'}}));
if(spec.selfTest){setTimeout(()=>process.exit(0),1200)}
else{setInterval(()=>console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'fixture'}})),100)}
`;
  try {
    await writeFile(entry,source);
    let requested=false;
    const parser=eventDecoder(event=>{
      if(event.type==='progress'&&event.activity?.deltas>0&&!requested){writeFileSync(join(managed(ids[0]),'cancel'),'test cancellation');requested=true;}
    });
    const [cancelled,other]=await Promise.all([
      run(process.execPath,[cli,'run','authority-ledger','--config',config,'--managed-run',ids[0],'--wall-seconds','15','--execute','--progress-json'],{env:{...process.env,HB_PI_ENTRY:entry},timeoutMs:30000,onStdout:b=>parser.push(b)}),
      run(process.execPath,[cli,'self-test','--config',config,'--managed-run',ids[1],'--wall-seconds','15'],{env:{...process.env,HB_PI_ENTRY:entry},timeoutMs:30000}),
    ]);
    assert.equal(requested,true);
    assert.equal(cancelled.code,1,cancelled.stderr);
    assert.equal(other.code,0,other.stderr);
    assert.equal(JSON.parse(other.stdout.trim()).status,'self_test_passed');
    const final=cancelled.stdout.trim().split('\n').map(JSON.parse).findLast(e=>e.resultFile);
    assert.equal(final.status,'aborted');
    for(const id of ids){
      const attempts=await readdir(join(managed(id),'runs'));
      assert.equal(attempts.length,1);
      const spec=JSON.parse(await readFile(join(managed(id),'runs',attempts[0],'spec.json'),'utf8'));
      const check=await run('docker',['inspect',spec.container]);
      assert.notEqual(check.code,0,'candidate container was not removed');
    }
    assert.equal(await readFile(legacy,'utf8').catch(()=>null),previousLegacy,'legacy lock changed');
  } finally {
    await rm(directory,{recursive:true,force:true});
    for(const id of ids)await rm(managed(id),{recursive:true,force:true});
  }
});
