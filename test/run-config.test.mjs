import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const config = fileURLToPath(new URL('../run.json', import.meta.url));

test('run config selects the model directly without an alias or inference', () => {
  const result = spawnSync(process.execPath, [cli, 'run', 'authority-ledger', '--config', config, '--repeat', '1'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.mode, 'plan-only');
  assert.deepEqual(plan.model, { provider: 'openrouter', model: 'moonshotai/kimi-k3', thinking: 'max' });
  assert.equal(plan.task, 'authority-ledger');
  assert.equal(plan.repeat, 1);
  assert.equal(plan.limits.wallSeconds, 1800);
  assert.equal(plan.limits.maxEstimatedUsd, 5);
  assert.equal(plan.limits.maxRequests, 40);
});

test('explicit wall-clock limits remain supported', () => {
  const result = spawnSync(process.execPath, [cli, 'run', 'authority-ledger', '--config', config, '--wall-seconds', '300'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).limits.wallSeconds, 300);
});

test('authority ledger clamps agent work to 30 minutes', () => {
  const result = spawnSync(process.execPath, [cli, 'run', 'authority-ledger', '--config', config, '--wall-seconds', '2700'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).limits.wallSeconds, 1800);
});

test('45-minute and five-dollar limits are accepted explicitly', () => {
  const result = spawnSync(process.execPath, [cli, 'run', 'kangaroo-bike', '--config', config, '--wall-seconds', '2700', '--max-estimated-usd', '5'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.limits.wallSeconds, 2700);
  assert.equal(plan.limits.maxEstimatedUsd, 5);
});

test('missing config fails before inference', () => {
  const result = spawnSync(process.execPath, [cli, 'run', 'authority-ledger', '--config', `${config}.missing`], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot read model configuration/);
});
