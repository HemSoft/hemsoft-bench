import test from 'node:test';
import assert from 'node:assert/strict';
import { Activity, eventDecoder, formatActivity } from '../src/activity.mjs';

test('live activity distinguishes reasoning, tools, and silence without leaking content', () => {
  let now = 0;
  const activity = new Activity(() => now);
  assert.match(formatActivity(activity.snapshot(), 900), /last model none yet/);
  now = 1000;
  activity.accept({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'PRIVATE_REASONING'}});
  assert.equal(activity.snapshot().phase, 'Reasoning stream');
  assert.equal(activity.snapshot().deltas, 1);
  now = 11000;
  assert.match(formatActivity(activity.snapshot(), 900), /last model 10s ago/);
  activity.accept({type:'tool_execution_start',toolName:'sandbox_write',toolCallId:'a',args:{content:'PRIVATE_CODE'}});
  assert.deepEqual(activity.snapshot().activeTools, ['sandbox_write']);
  activity.accept({type:'tool_execution_end',toolName:'sandbox_write',toolCallId:'a',isError:false});
  assert.equal(activity.snapshot().toolsCompleted, 1);
  assert.equal(activity.snapshot().writesCompleted, 1);
  now = 71000;
  assert.match(formatActivity(activity.snapshot(), 900), /QUIET 60s/);
  assert.doesNotMatch(JSON.stringify(activity.snapshot()), /PRIVATE/);
  activity.accept({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'PRIVATE_TEXT'}});
  assert.doesNotMatch(formatActivity(activity.snapshot(), 900), /QUIET|PRIVATE/);
});

test('tool errors, overlapping tools, and terminal-injection labels are handled', () => {
  const a = new Activity(() => 0);
  a.accept({type:'tool_execution_start',toolCallId:'1',toolName:'sandbox_bash'});
  a.accept({type:'tool_execution_start',toolCallId:'2',toolName:'sandbox_edit'});
  a.accept({type:'tool_execution_end',toolCallId:'2',toolName:'sandbox_edit',isError:true});
  assert.equal(a.snapshot().toolErrors, 1);
  assert.equal(a.snapshot().writesCompleted, 0);
  assert.deepEqual(a.snapshot().activeTools, ['sandbox_bash']);
  a.accept({type:'tool_execution_start',toolCallId:'3',toolName:'\x1b[2Jmalicious'});
  assert.doesNotMatch(formatActivity(a.snapshot(), 900), /\x1b|malicious/);
});

test('event decoder handles byte-split UTF-8, multiple lines, and incomplete tails', () => {
  const events = [];
  const decoder = eventDecoder(event => events.push(event));
  const data = Buffer.from(JSON.stringify({type:'message_update',text:'café 😀\u2028'}) + '\n' + JSON.stringify({type:'agent_end'}) + '\n{"type":');
  for (const byte of data) decoder.push(Buffer.from([byte]));
  assert.equal(events.length, 2);
  assert.equal(events[0].text, 'café 😀\u2028');
  assert.deepEqual(decoder.end(), {malformed:1});
});

test('decoder accepts a valid final line and bounds incomplete lines', () => {
  const events = [];
  const decoder = eventDecoder(event => events.push(event));
  decoder.push(Buffer.from('{"type":"agent_end"}'));
  assert.deepEqual(decoder.end(), {malformed:0});
  assert.equal(events.length, 1);
  assert.throws(() => eventDecoder(() => {}, 4).push(Buffer.from('12345')), /limit/);
});

test('local events do not pretend to be provider activity', () => {
  let now = 0;
  const a = new Activity(() => now);
  now = 65000;
  a.accept({type:'tool_execution_update'});
  assert.equal(a.snapshot().secondsSinceModelResponse, null);
  assert.equal(a.snapshot().secondsSinceEvent, 0);
});
