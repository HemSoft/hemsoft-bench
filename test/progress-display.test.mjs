import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Activity, formatCompactActivity } from '../src/activity.mjs';

const script = fileURLToPath(new URL('../src/progress.ps1', import.meta.url)).replaceAll("'", "''");
const hasPwsh = !spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).error;
function powershell(body) {
  const execution = spawnSync('pwsh', ['-NoProfile', '-Command', `$ErrorActionPreference='Stop'; $PSStyle.OutputRendering='Ansi'; . '${script}'; ${body}`], { encoding: 'utf8' });
  assert.equal(execution.status, 0, execution.stderr);
  return execution.stdout;
}

test('compact activity omits noisy counters but retains elapsed time and health', () => {
  const a = new Activity(() => 0);
  const state = { ...a.snapshot(), executionElapsedSeconds:85, phase:'Running sandbox_bash', secondsSinceEvent:0, toolsStarted:8, toolsCompleted:6 };
  assert.equal(formatCompactActivity(state,1800), 'Tool: bash | 1:25/30:00 | last event 0s | tools 6/8 | edits 0');
  assert.doesNotMatch(formatCompactActivity(state,1800), /deltas|errors 0/);
  assert.match(formatCompactActivity({...state,silenceSeconds:70,toolErrors:1},1800), /QUIET 70s.*errors 1/);
});

test('interactive output replaces a single row and clears it before a result', {skip:!hasPwsh}, () => {
  const output = powershell(`
$s=New-BenchProgressState -Interactive $true
$e=[pscustomobject]@{task='task';attempt=1;repeat=1;stage='Model running';text='[task 1/1] Reasoning | 1:20/30:00';quiet=$false;toolErrors=0}
Write-BenchProgress -State $s -Event $e -Width 80 -Now 0
$e.text='[task 1/1] Waiting'
Write-BenchProgress -State $s -Event $e -Width 80 -Now 1000
Clear-BenchProgress -State $s
Write-Host 'FINAL RESULT'
`);
  assert.equal((output.match(/\x1b\[2K/g) ?? []).length, 3);
  const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /\r\x1b\[2K\[task 1\/1\] Waiting\r\x1b\[2KFINAL RESULT/);
  assert.equal((plain.match(/\n/g) ?? []).length, 1);
});

test('narrow terminal output is clipped and control characters cannot escape', {skip:!hasPwsh}, () => {
  const output = powershell(`
Format-BenchProgressLine -Text ('x'*100) -Width 30
Format-BenchProgressLine -Text ("safe"+[char]27+"[2J"+[char]10+"text") -Width 50
`);
  const lines = output.trim().split(/\r?\n/);
  assert.equal(lines[0].length, 29);
  assert.ok(lines[0].endsWith('...'));
  assert.doesNotMatch(lines[1], /\x1b|\n/);
});

test('plain output coalesces tool boundaries and immediately exposes silence and errors', {skip:!hasPwsh}, () => {
  const output = powershell(`
$s=New-BenchProgressState -Interactive $false
$e=[pscustomobject]@{task='task';attempt=1;repeat=1;stage='Model running';text='FIRST';quiet=$false;toolErrors=0}
Write-BenchProgress -State $s -Event $e -Now 0
$e.text='SUPPRESSED'
Write-BenchProgress -State $s -Event $e -Now 1000
$e.text='QUIET';$e.quiet=$true
Write-BenchProgress -State $s -Event $e -Now 2000
$e.text='TOOL ERROR';$e.toolErrors=1
Write-BenchProgress -State $s -Event $e -Now 3000
$e.text='HEARTBEAT'
Write-BenchProgress -State $s -Event $e -Now 33000
`);
  assert.deepEqual(output.trim().split(/\r?\n/), ['FIRST','QUIET','TOOL ERROR','HEARTBEAT']);
  assert.doesNotMatch(output, /\x1b/);
});
