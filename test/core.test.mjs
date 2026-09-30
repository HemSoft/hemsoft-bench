import { test } from 'node:test';
import assert from 'node:assert/strict';
import { piArgs, containerArgs, summarizeEvents, summarizeRuns, validateModel, TOOL_NAMES, SYSTEM_PROMPT } from '../src/core.mjs';

test('Pi uses only sandbox tools and disables ambient resources', () => {
  const args = piArgs({ provider: 'openrouter', model: 'org/model', thinking: 'high' }, '/trusted/tools.ts');
  for (const flag of ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-builtin-tools', '--no-session', '--offline']) assert.ok(args.includes(flag));
  assert.equal(args[args.indexOf('--tools') + 1], TOOL_NAMES.join(','));
  assert.ok(TOOL_NAMES.every(x => x.startsWith('sandbox_')));
  assert.equal(args[args.indexOf('--model') + 1], 'org/model');
  assert.equal(args[args.indexOf('--extension') + 1], '/trusted/tools.ts');
  assert.ok(!SYSTEM_PROMPT.includes('D:'));
});

test('sandbox has no bind mounts, keys, network, or elevated privileges', () => {
  const args = containerArgs('hb-test', 'sha256:' + 'a'.repeat(64));
  for (const x of ['--read-only', '--init', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network=none', '--user=1000:1000']) assert.ok(args.includes(x));
  assert.ok(!args.some(x => ['-v', '--volume', '--mount', '-e', '--env', '--privileged'].includes(x)));
  assert.ok(args.includes('--memory=256m'));
  assert.ok(args.includes('--pids-limit=64'));
});

test('invalid models and fuzzy selectors are refused', () => {
  for (const model of ['', '*', 'some-model:high', '--help']) assert.throws(() => validateModel({ provider: 'openrouter', model, thinking: 'high' }));
  assert.throws(() => validateModel({ provider: '', model: 'abc', thinking: 'high' }));
  assert.throws(() => validateModel({ provider: 'openrouter', model: 'abc', thinking: 'maximum' }));
  assert.doesNotThrow(() => validateModel({ provider: 'openrouter', model: 'org/model', thinking: 'high' }));
  assert.doesNotThrow(() => validateModel({ provider: 'openrouter', model: 'org/model:free', thinking: 'off' }));
});

test('usage counts authoritative assistant messages once, never agent_end copies', () => {
  const message = { role: 'assistant', model: 'm', provider: 'p', stopReason: 'stop', content: [{type:'text',text:'done'}], usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 3, cost: {total: 0.1} } };
  const summary = summarizeEvents([
    {type:'message_update',usage:message.usage},
    {type:'message_end',message},
    {type:'agent_end',messages:[message]},
  ]);
  assert.equal(summary.usage.input, 10);
  assert.equal(summary.usage.totalTokens, 20);
  assert.equal(summary.estimatedCostUsd, 0.1);
  assert.equal(summary.finalText, 'done');
  assert.equal(summary.completed, true);
});

test('missing usage is unknown rather than free and missing completion is failure', () => {
  const result = summarizeEvents([{type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'provider failed'}}]);
  assert.equal(result.estimatedCostUsd, null);
  assert.equal(result.completed, false);
  assert.equal(result.providerErrors.length, 1);
  assert.equal(summarizeEvents([]).completed, false);
});

test('reports retain failures and separate changes instead of mixing incompatible scores', () => {
  const base={task:'t',model:{provider:'p',model:'m'},image:'i',limits:{maxRequests:40},fingerprints:{caseSet:'a'}};
  const rows=summarizeRuns([
    {...base,status:'passed',metrics:{estimatedCostUsd:0.1}},
    {...base,status:'provider_error'},
    {...base,status:'passed',selfTest:true},
    {...base,status:'failed',fingerprints:{caseSet:'b'},metrics:{estimatedCostUsd:0.2}},
  ]);
  assert.equal(rows.length,2);
  assert.equal(rows[0].attempts,2);
  assert.equal(rows[0].fullPasses,1);
  assert.equal(rows[0].statuses.provider_error,1);
  assert.equal(rows[0].estimatedCostUsd,null);
});

test('interrupted reasoning cannot report complete usage or cost', () => {
  const message = {role:'assistant',stopReason:'toolUse',content:[],usage:{input:89,output:57,cacheRead:512,cacheWrite:0,cost:{total:0.0013}}};
  const events = [
    {type:'message_end',message},
    {type:'message_start',message:{role:'assistant'}},
    {type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'reasoning'}},
  ];
  const summary = summarizeEvents(events);
  assert.equal(summary.usage.totalTokens, 658);
  assert.equal(summary.usageComplete, false);
  assert.equal(summary.estimatedCostUsd, null);
  assert.equal(summary.reportedEstimatedCostUsd, 0.0013);
  assert.equal(summary.completed, false);
});

test('execution interruption invalidates otherwise complete usage', () => {
  const events = [{type:'message_end',message:{role:'assistant',stopReason:'stop',content:[],usage:{input:1,output:2,cacheRead:0,cacheWrite:0,cost:{total:0.01}}}}];
  const summary = summarizeEvents(events, {interrupted:true});
  assert.equal(summary.usageComplete, false);
  assert.equal(summary.estimatedCostUsd, null);
  assert.equal(summary.completed, false);
});

test('historical timeout estimates are not counted as complete costs', () => {
  const [row] = summarizeRuns([{task:'t',status:'timeout',metrics:{usageComplete:true,estimatedCostUsd:0.0013}}]);
  assert.equal(row.estimatedCostUsd, null);
  assert.equal(row.costComplete, false);
});

test('reports separate managed worker capacities and legacy executions', () => {
  const base={task:'t',model:{provider:'p',model:'m'},status:'passed',metrics:{estimatedCostUsd:0.1}};
  const groups=summarizeRuns([base,{...base,executionContext:{mode:'managed',concurrency:1}},{...base,executionContext:{mode:'managed',concurrency:2}}]);
  assert.equal(groups.length,3);
});

test('tool-only termination is not a completed answer', () => {
  assert.equal(summarizeEvents([{type:'message_end',message:{role:'assistant',content:[],stopReason:'toolUse'}}]).completed, false);
});
