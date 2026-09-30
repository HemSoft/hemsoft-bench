import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {visualFilename} from '../src/visual.mjs';
const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
const config=fileURLToPath(new URL('../run.json',import.meta.url));
test('visual task is explicit and plan-only unless --execute is present',()=>{
 const list=spawnSync(process.execPath,[cli,'tasks'],{encoding:'utf8'});
 assert.equal(list.status,0);assert.match(list.stdout,/kangaroo-bike v1 \(visual artifact for human review; no automatic score\)/);
 const plan=spawnSync(process.execPath,[cli,'run','kangaroo-bike','--config',config,'--repeat','1'],{encoding:'utf8'});
 assert.equal(plan.status,0);const data=JSON.parse(plan.stdout);
 assert.equal(data.mode,'plan-only');assert.equal(data.task,'kangaroo-bike');
 assert.equal(data.model.model,'moonshotai/kimi-k3');
});
test('model artifact names use only the exact final model ID segment',()=>{
 assert.equal(visualFilename({model:'moonshotai/kimi-k3'}),'kimi-k3-bike.svg');
 assert.equal(visualFilename({model:'gpt-5.6-sol'}),'gpt-5.6-sol-bike.svg');
 for(const value of ['../secret','provider/','/../','bad:batch','a\\b',' space','x'.repeat(101)])assert.throws(()=>visualFilename({model:value}));
});
