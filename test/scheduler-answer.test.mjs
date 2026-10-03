import test from 'node:test';
import assert from 'node:assert/strict';
import {schedulerAnswerMatches} from '../src/scheduler-task.mjs';
import {scoreAnswers} from '../src/tasks.mjs';

const blocked=(job,dependency='parent',at=1)=>({at,event:'blocked',job,dependency});
const answer=timeline=>({timeline,jobs:[{id:'a',status:'blocked',attempts:0},{id:'z',status:'blocked',attempts:0}],effects:[]});
const expected=answer([blocked('z'),blocked('a')]);

test('independent same-time block notifications may have a different occurrence order',()=>{
 const actual=answer([blocked('a'),blocked('z')]);
 const before=structuredClone(actual);
 assert.equal(schedulerAnswerMatches(actual,expected),true);
 assert.deepEqual(actual,before,'comparison must not rewrite the submission trace');
});

test('offline task scoring shares the live scheduler comparison rules',()=>{
 assert.deepEqual(scoreAnswers([expected],[answer([blocked('a'),blocked('z')])]),{passed:1,total:1,success:true});
 assert.equal(scoreAnswers([expected],[answer([blocked('a','wrong-parent'),blocked('z')])]).success,false);
});

test('block ordering still respects dependency causality',()=>{
 const valid=answer([blocked('parent','failed-root'),blocked('z','parent'),blocked('a','parent')]);
 assert.equal(schedulerAnswerMatches(answer([blocked('parent','failed-root'),blocked('a','parent'),blocked('z','parent')]),valid),true);
 assert.equal(schedulerAnswerMatches(answer([blocked('a','parent'),blocked('parent','failed-root'),blocked('z','parent')]),valid),false);
});

for(const [name,timeline] of [
 ['wrong timestamp',[blocked('a','parent',2),blocked('z')]],
 ['wrong dependency',[blocked('a','different-parent'),blocked('z')]],
 ['missing event',[blocked('a')]],
 ['extra event',[blocked('a'),blocked('z'),blocked('extra')]],
 ['duplicate event',[blocked('a'),blocked('z'),blocked('z')]],
 ['extra payload field',[{...blocked('a'),unexpected:true},blocked('z')]],
])test(`block normalization rejects ${name}`,()=>{
 assert.equal(schedulerAnswerMatches(answer(timeline),expected),false);
});

test('dispatch and external-operation event order remains significant',()=>{
 const started=job=>({at:1,event:'started',job,worker:'w',attempt:1,token:job+':1',leaseUntil:5});
 assert.equal(schedulerAnswerMatches(answer([started('a'),started('z')]),answer([started('z'),started('a')])),false);
 const cancelled={at:1,event:'cancelled',job:'parent'};
 assert.equal(schedulerAnswerMatches(answer([blocked('a'),blocked('z'),cancelled]),answer([cancelled,blocked('z'),blocked('a')])),false);
});

test('blocks cannot move across dispatch boundaries even at the same timestamp',()=>{
 const boundary={at:1,event:'started',job:'other',worker:'w',attempt:1,token:'other:1',leaseUntil:5};
 assert.equal(schedulerAnswerMatches(answer([blocked('a'),boundary,blocked('z')]),answer([blocked('z'),boundary,blocked('a')])),false);
});

test('final job states, attempt counts and effects still require exact agreement',()=>{
 const actual=answer([blocked('a'),blocked('z')]);
 for(const patch of [{effects:['extra']},{jobs:[{id:'a',status:'running',attempts:1}]}]){
  assert.equal(schedulerAnswerMatches({...actual,...patch},expected),false);
 }
});

test('JSON field order remains irrelevant but missing answers do not match',()=>{
 assert.equal(schedulerAnswerMatches({effects:[],jobs:expected.jobs,timeline:expected.timeline},expected),true);
 assert.equal(schedulerAnswerMatches(null,expected),false);
});
