import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {TASK_IDS,taskCases,expectedAnswers,scoreAnswers} from '../src/tasks.mjs';
import {schedulerAnswers} from '../src/scheduler-task.mjs';

const reference=fileURLToPath(new URL('../references/resilient-scheduler.py',import.meta.url));
const runner=fileURLToPath(new URL('../tasks/resilient-scheduler/runner.py',import.meta.url));
const starterDir=fileURLToPath(new URL('../tasks/resilient-scheduler/',import.meta.url));

test('scheduler cases cover interacting recovery and dispatch rules',()=>{
  const cases=taskCases('resilient-scheduler');
  assert.equal(cases.length,72);
  const text=JSON.stringify(cases);
  for(const marker of ['checkpoint','heartbeat','workerDown','mutex','requires','effect','labels','maxAttempts'])assert.match(text,new RegExp(marker));
});

test('planted shallow schedulers receive partial credit but cannot pass',()=>{
  const cases=taskCases('resilient-scheduler'),expected=expectedAnswers('resilient-scheduler',cases);
  for(const options of [{noAging:true},{firstFit:true},{noLeases:true},{noBackoff:true},{acceptStale:true},{noMutex:true},{noDependencyPropagation:true}]){
    const grade=scoreAnswers(expected,schedulerAnswers(cases,options));
    assert.ok(grade.passed>0,JSON.stringify(options));
    assert.ok(grade.passed<grade.total,JSON.stringify(options));
  }
});

test('intentionally defective multi-file starter earns useful partial credit',()=>{
  const cases=taskCases('resilient-scheduler'),expected=expectedAnswers('resilient-scheduler',cases);
  const run=spawnSync('python',[runner],{cwd:starterDir,input:JSON.stringify({cases}),encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const grade=scoreAnswers(expected,JSON.parse(run.stdout));
  assert.ok(grade.passed>=15&&grade.passed<=45,JSON.stringify(grade));
});

test('independent Python scheduler reference agrees with every generated case',()=>{
  const cases=taskCases('resilient-scheduler'),expected=expectedAnswers('resilient-scheduler',cases);
  const run=spawnSync('python',[reference],{input:JSON.stringify({cases}),encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  assert.deepEqual(scoreAnswers(expected,JSON.parse(run.stdout)),{passed:72,total:72,success:true});
});

test('case generation is reproducible and scoring rejects shortcuts',()=>{
  assert.deepEqual(TASK_IDS,['resilient-scheduler']);
  const a=taskCases(TASK_IDS[0]),b=taskCases(TASK_IDS[0]);
  assert.deepEqual(a,b);
  const expected=expectedAnswers(TASK_IDS[0],a);
  assert.equal(scoreAnswers(expected,[]).success,false);
  const altered=structuredClone(expected);altered[0].jobs[0].status='failed';
  assert.equal(scoreAnswers(expected,altered).passed,expected.length-1);
});
