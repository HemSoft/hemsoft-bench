import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {taskCases, expectedAnswers, scoreAnswers, TASK_IDS} from '../src/tasks.mjs';
import {authorityReference} from '../src/authority-task.mjs';

test('authority ledger covers corrections, specificity, groups and delegation without self-support',()=>{
  const cases=taskCases('authority-ledger');
  assert.equal(cases.length,60);
  assert.deepEqual(authorityReference(cases[7]).map(answer=>answer.decision),['allow','deny']);
  assert.deepEqual(authorityReference(cases[10]).map(answer=>answer.decision),['allow','deny']);
  assert.deepEqual(authorityReference(cases[11]).map(answer=>answer.rule),[null,null]);
  assert.ok(cases.slice(15,25).flatMap(authorityReference).some(answer=>answer.authority.length>=3));
});

test('authority case families reject shallow and partly correct implementations',()=>{
  const cases=taskCases('authority-ledger'), expected=expectedAnswers('authority-ledger',cases);
  const defaultDeny=cases.map(testCase=>testCase.queries.map(()=>({decision:'deny',rule:null,authority:[],subjectPath:[]})));
  const noDelegation=expected.map(answers=>answers.map(answer=>answer.authority.length>1?{decision:'deny',rule:null,authority:[],subjectPath:[]}:answer));
  const latestKnowledge=cases.map(testCase=>({...testCase,queries:testCase.queries.map(query=>({...query,known:1_000_000}))}));
  assert.deepEqual(scoreAnswers(expected,defaultDeny),{passed:14,total:60,success:false});
  assert.deepEqual(scoreAnswers(expected,noDelegation),{passed:45,total:60,success:false});
  assert.deepEqual(scoreAnswers(expected,expectedAnswers('authority-ledger',latestKnowledge)),{passed:43,total:60,success:false});
});

test('independent Python authority reference agrees with every generated case',()=>{
  const cases=taskCases('authority-ledger'), expected=cases.map(authorityReference);
  const reference=fileURLToPath(new URL('../references/authority-ledger.py',import.meta.url));
  const execution=spawnSync('python',['-I',reference],{input:JSON.stringify({cases}),encoding:'utf8',maxBuffer:10*1024*1024,timeout:120000});
  assert.equal(execution.status,0,execution.stderr);
  assert.deepEqual(JSON.parse(execution.stdout),expected);
});

test('case generation is reproducible and scoring rejects format shortcuts and altered values',()=>{
  assert.deepEqual(TASK_IDS,['authority-ledger']);
  const expected=expectedAnswers('authority-ledger');
  assert.deepEqual(taskCases('authority-ledger'),taskCases('authority-ledger'));
  assert.equal(scoreAnswers(expected,structuredClone(expected)).success,true);
  assert.equal(scoreAnswers(expected,[]).success,false);
  assert.equal(scoreAnswers(expected,null).success,false);
  const wrong=structuredClone(expected);wrong[0]='wrong';
  assert.equal(scoreAnswers(expected,wrong).passed,expected.length-1);
  assert.throws(()=>taskCases('removed-task'),/Unknown task/);
});
