import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../run.ps1', import.meta.url));
const hasPwsh = !spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).error;
const quote = value => `'${value.replaceAll("'", "''")}'`;

for (const [status, keepHistory, recovered=false] of [['passed', false], ['provider_error', false], ['timeout', false], ['passed', true], ['provider_error',true,true], ['timeout',true,true]]) {
  const failure = status !== 'passed';
  test(`PowerShell waits and summarizes current results, status=${status}, keepHistory=${keepHistory}, recovered=${recovered}`, { skip: !hasPwsh }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-display-'));
    try {
      const resultPath = join(dir, 'result.json');
      writeFileSync(resultPath, JSON.stringify({
        task: 'resilient-scheduler', status,
        grade: failure ? null : { passed: 37, total: 72 }, elapsedSeconds: 12.3,
        ...(recovered ? {error:'WebSocket error',recovery:{state:'graded',grade:{passed:37,total:72,success:false}},metrics:{usageComplete:false,usage:{totalTokens:43362},estimatedCostUsd:null,reportedEstimatedCostUsd:0.1788}} : failure ? {} : { metrics: { usageComplete: true, usage: { totalTokens: 123 }, estimatedCostUsd: 0.01 } })
      }));
      const visualPath = join(dir, 'visual.json');
      writeFileSync(visualPath,JSON.stringify({task:'kangaroo-bike',status:'needs_visual_review',grade:null,elapsedSeconds:9.1,artifact:{file:join(dir,'kimi-k3-bike.svg')},metrics:{usageComplete:true,usage:{totalTokens:50},estimatedCostUsd:0.02}}));
      const worldPath=join(dir,'world.json');
      writeFileSync(worldPath,JSON.stringify({task:'world-clock',status:'needs_visual_review',grade:null,elapsedSeconds:8.4,presentations:[{kind:'webpage',file:join(dir,'world-clock.html')}],metrics:{usageComplete:true,usage:{totalTokens:40},estimatedCostUsd:0.02}}));
      const stub = `
function global:node {
  $global:LASTEXITCODE = 0
  if ($args[1] -eq 'run') {
    if ($args -contains '--execute') {
      if ($args -notcontains '--progress-json') { throw 'Expected structured progress' }
      $task = $args[2]
      1..20 | ForEach-Object {
        @{type='progress';task=$task;attempt=1;repeat=1;stage='Model running';text="LIVE-STATUS $_";quiet=$false;toolErrors=0} | ConvertTo-Json -Compress
      }
      $file = if ($args[2] -eq 'kangaroo-bike') { ${quote(visualPath)} } elseif ($args[2] -eq 'world-clock') { ${quote(worldPath)} } else { ${quote(resultPath)} }
      @{ resultFile = $file } | ConvertTo-Json -Compress
      $global:LASTEXITCODE = ${failure ? 1 : 0}
    } else { '{"mode":"plan-only"}' }
  } elseif ($args[1] -eq 'self-test') { '{"status":"self_test_passed"}' }
  elseif ($args[1] -eq 'begin') {
    if (($args -contains '--keep-history') -ne $${keepHistory}) { throw 'Incorrect retention flag' }
    '{"id":"fixture-invocation","removed":0}'
  }
  elseif ($args[1] -eq 'end') { }
  else { 'Offline fixture ready' }
}
& ${quote(script)} -Execute ${keepHistory ? '-KeepHistory' : ''}
exit $LASTEXITCODE
`;
      const fixture = join(dir, 'fixture.ps1');
      writeFileSync(fixture, stub);
      const execution = spawnSync('pwsh', ['-NoProfile', '-File', fixture], { encoding: 'utf8' });
      assert.equal(execution.status, failure ? 1 : 0, execution.stderr+'\n'+execution.stdout);
      assert.match(execution.stdout, /Results for this invocation/);
      assert.equal((execution.stdout.match(/LIVE-STATUS/g) ?? []).length, failure ? 1 : 3);
      assert.doesNotMatch(execution.stdout, /\u001b\[2K/);
      assert.match(execution.stdout, failure ? /1\/3 attempts recorded/ : /3\/3 attempts recorded/);
      assert.match(execution.stdout, recovered ? /37\/72 recovered/ : failure ? /not graded/ : /37\/72/);
      assert.match(execution.stdout, recovered ? /0[.,]1788\*/ : failure ? /unknown/ : /0[.,]0100/);
      if(recovered) {
        assert.match(execution.stdout,/WebSocket error/);
        assert.match(execution.stdout,/43362\*/);
        assert.match(execution.stdout,/does not count as a completed run/);
        assert.match(execution.stdout,/Observed usage\/cost is incomplete/);
      }
      if (failure) assert.match(execution.stdout, /Run stopped early/);
      else {assert.match(execution.stdout,/needs_visual_review/);assert.match(execution.stdout,/SVG for human review:/);}
      assert.doesNotMatch(execution.stderr, /Write-Error|Line \|/);
      if (status === 'timeout') {
        assert.match(execution.stdout, /Time limit reached/);
        assert.match(execution.stdout, /No automatic retry/);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
