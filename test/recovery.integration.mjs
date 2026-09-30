import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { run } from '../src/process.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
// Fake provider, real Docker capture and hidden grading. No network/model calls.
for(const [outcome,exitCode] of [['provider_error',0],['provider_error',1],['timeout',0],['estimated_cost_limit',3],['request_limit',3],['incomplete',0],['aborted',0]]) {
  test(`saved code is graded after ${outcome} / exit ${exitCode}, without promoting the run to a pass`,async()=>{
    const temp=await mkdtemp(join(tmpdir(),'hb-recovery-'));
    const id=randomUUID(), managed=join(root,'.local','managed-runs',id);
    try {
      const fixture=join(temp,'pi.cjs'), config=join(temp,'run.json');
      await writeFile(config,JSON.stringify({model:{provider:'openai-codex',model:'gpt-5.6-sol',thinking:'high'}}));
      await writeFile(join(temp,'source.py'),await readFile(join(root,'references','authority-ledger.py')));
      await writeFile(fixture,`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
if(process.argv.includes('--version')){console.log('offline-fixture');process.exit(0)}
const spec=JSON.parse(fs.readFileSync(process.env.HB_RUN_SPEC,'utf8'));
const settings=JSON.parse(fs.readFileSync(path.join(process.cwd(),'.pi','settings.json'),'utf8'));
fs.writeFileSync(path.join(path.dirname(spec.statePath),'observed-settings.json'),JSON.stringify(settings));
fs.writeFileSync(spec.statePath,JSON.stringify({status:'ready'}));
const source=fs.readFileSync(path.join(__dirname,'source.py'),'utf8');
cp.execFileSync('docker',['exec','-i',spec.container,'python','-I','-c',"import sys;open('/workspace/solution.py','w').write(sys.stdin.read())"],{input:source});
const emit=e=>console.log(JSON.stringify(e));
emit({type:'message_start',message:{role:'assistant'}});
emit({type:'message_end',message:{role:'assistant',stopReason:'toolUse',content:[],usage:{input:10,output:20,cacheRead:0,cacheWrite:0,cost:{total:0.1}}}});
process.exitCode=${exitCode};
if(${JSON.stringify(outcome)}==='provider_error')emit({type:'message_end',message:{role:'assistant',stopReason:'error',errorMessage:'WebSocket error',content:[]}});
else if(${JSON.stringify(outcome)}==='aborted'){fs.writeFileSync(path.join(path.dirname(spec.statePath),'..','..','cancel'),'test');setInterval(()=>{},1000);}
else if(${JSON.stringify(outcome)}==='timeout')setInterval(()=>{},1000);
else if(${JSON.stringify(outcome)}!=='incomplete'){fs.writeFileSync(spec.statePath,JSON.stringify({status:'blocked',reason:${JSON.stringify(outcome)}}));}
`);
      const execution=await run(process.execPath,[join(root,'src/cli.mjs'),'run','authority-ledger','--config',config,'--managed-run',id,'--repeat','1','--wall-seconds','3','--execute'],{env:{...process.env,HB_PI_ENTRY:fixture},timeoutMs:30000});
      assert.equal(execution.code,1,execution.stderr);
      const event=JSON.parse(execution.stdout.trim());
      const result=JSON.parse(await readFile(event.resultFile,'utf8'));
      assert.equal(result.status,outcome);
      assert.equal(result.grade,null);
      assert.equal(result.recovery?.state,'graded','interrupted solution was discarded instead of graded');
      assert.equal(result.recovery.grade.success,true);
      assert.equal(result.recovery.grade.passed,60);
      assert.equal(result.metrics.usageComplete,false);
      assert.equal(result.metrics.estimatedCostUsd,null);
      assert.equal(result.executionPolicy.transport,'sse');
      const settings=JSON.parse(await readFile(join(event.resultFile,'..','observed-settings.json'),'utf8'));
      assert.equal(settings.transport,'sse');
      assert.equal(settings.retry.enabled,true);
      assert.equal(settings.retry.maxRetries,2);
      assert.equal(settings.retry.provider.maxRetries,0);
      if(outcome==='provider_error')assert.equal(result.error,'WebSocket error');
      assert.ok((await readFile(join(event.resultFile,'..','submission.py'),'utf8')).length>0);
    }finally{await rm(temp,{recursive:true,force:true});await rm(managed,{recursive:true,force:true});}
  });
}
