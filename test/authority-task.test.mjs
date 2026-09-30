import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const reference=fileURLToPath(new URL('../references/authority-ledger.py',import.meta.url));
const publicTests=fileURLToPath(new URL('../tasks/authority-ledger/public_tests.py',import.meta.url));

test('Authority Ledger public tests agree with the independent Python reference',()=>{
  const directory=mkdtempSync(join(tmpdir(),'hb-authority-public-'));
  try {
    copyFileSync(reference,join(directory,'solution.py'));
    copyFileSync(publicTests,join(directory,'public_tests.py'));
    const execution=spawnSync('python',['public_tests.py'],{cwd:directory,encoding:'utf8',timeout:30000});
    assert.equal(execution.status,0,execution.stderr||execution.stdout);
    assert.match(execution.stderr,/Ran 6 tests/);
  } finally {rmSync(directory,{recursive:true,force:true});}
});
