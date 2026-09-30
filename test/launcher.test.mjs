import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const available = process.platform === 'win32' && !spawnSync('pwsh.exe', ['-NoProfile', '-Command', 'exit 0']).error;

test('Windows launcher finds its script, forwards options, and preserves failure status', { skip: !available }, () => {
  // Run only a stub, never the real benchmark or its cleanup.
  const directory = mkdtempSync(join(tmpdir(), 'hb launcher test '));
  try {
    copyFileSync(fileURLToPath(new URL('../run.cmd', import.meta.url)), join(directory, 'run.cmd'));
    writeFileSync(join(directory, 'run.ps1'), `
param([switch]$Execute, [switch]$KeepHistory, [string]$Config)
@{execute=[bool]$Execute; keepHistory=[bool]$KeepHistory; config=$Config; scriptRoot=$PSScriptRoot} | ConvertTo-Json -Compress
exit 7
`);
    const result = spawnSync('cmd.exe', ['/d', '/c', 'run.cmd', '-KeepHistory', '-Config', 'alternate.json'], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 7, result.stderr);
    const actual = JSON.parse(result.stdout.trim());
    assert.equal(actual.execute, true);
    assert.equal(actual.keepHistory, true);
    assert.equal(actual.config, 'alternate.json');
    assert.equal(actual.scriptRoot, directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
