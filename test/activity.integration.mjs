import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { run } from '../src/process.mjs';

// Real runner and Docker, synthetic Pi stream. No provider authentication or inference.
test('CLI persists activity and raw events during execution and keeps stdout JSON-only', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hb-telemetry-fixture-'));
  const fixture = join(directory, 'pi-fixture.cjs');
  let resultDirectory;
  const managedID=randomUUID();
  const managedDirectory=fileURLToPath(new URL(`../.local/managed-runs/${managedID}/`,import.meta.url));
  try {
    await writeFile(fixture, `
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('offline-fixture'); process.exit(0); }
const spec = JSON.parse(fs.readFileSync(process.env.HB_RUN_SPEC, 'utf8'));
const directory = path.dirname(spec.statePath);
const emit = event => console.log(JSON.stringify(event));
emit({type:'message_update',assistantMessageEvent:{type:'thinking_delta',delta:'private content'}});
emit({type:'tool_execution_start',toolName:'sandbox_write',toolCallId:'fixture'});
process.stderr.write('offline diagnostic');
const timer = setInterval(() => {
  // Completion depends on observing the parent's live disk writes.
  try {
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'activity.json'), 'utf8'));
    const raw = fs.readFileSync(path.join(directory, 'events.jsonl'), 'utf8');
    if (state.toolsStarted !== 1 || !raw.includes('tool_execution_start')) return;
  } catch { return; }
  clearInterval(timer);
  emit({type:'tool_execution_end',toolName:'sandbox_write',toolCallId:'fixture',isError:false});
  emit({type:'agent_end'});
  fs.writeFileSync(spec.statePath, JSON.stringify({status:'self_test_passed'}));
}, 25);
`);
    const execution = await run(process.execPath, [
      fileURLToPath(new URL('../src/cli.mjs', import.meta.url)),
      'self-test', '--config', fileURLToPath(new URL('../run.json', import.meta.url)),
      '--wall-seconds', '5', '--progress', '--managed-run', managedID,
    ], { env: { ...process.env, HB_PI_ENTRY: fixture }, timeoutMs: 30000 });
    assert.equal(execution.failure, null);
    assert.equal(execution.code, 0, execution.stderr);
    const result = JSON.parse(execution.stdout.trim());
    resultDirectory = dirname(result.resultFile);
    assert.equal(result.status, 'self_test_passed');
    assert.match(execution.stderr, /Running sandbox_write/);
    assert.doesNotMatch(execution.stderr, /private content|offline diagnostic/);
    const state = JSON.parse(await readFile(join(resultDirectory, 'activity.json'), 'utf8'));
    assert.equal(state.status, 'self_test_passed');
    assert.equal(state.toolsStarted, 1);
    assert.equal(state.toolsCompleted, 1);
    assert.equal(state.writesCompleted, 1);
    assert.equal(state.deltas, 1);
    assert.match(await readFile(join(resultDirectory, 'events.jsonl'), 'utf8'), /private content/);
    assert.equal(await readFile(join(resultDirectory, 'stderr.txt'), 'utf8'), 'offline diagnostic');
  } finally {
    await rm(directory, { recursive: true, force: true });
    // Remove only this synthetic self-test's artifacts, never real benchmark runs.
    await rm(managedDirectory, { recursive: true, force: true });
  }
});
