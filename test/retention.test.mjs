import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireRunLock, validateRunLock, releaseRunLock, pruneRuns } from '../src/retention.mjs';

async function trial(local, status = 'timeout') {
  const id = randomUUID(), dir = join(local, 'runs', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'result.json'), JSON.stringify({ id, status }));
  await writeFile(join(dir, 'events.jsonl'), 'private log');
  return id;
}

test('default retention removes all previous finalized attempts, including passes and self-tests', async () => {
  const local = await mkdtemp(join(tmpdir(), 'hb-retention-'));
  try {
    await trial(local, 'passed'); await trial(local, 'timeout'); await trial(local, 'self_test_passed');
    await writeFile(join(local, 'runtime.json'), 'pinned image');
    const lease = await acquireRunLock(local);
    assert.equal(await pruneRuns(local, lease.id), 3);
    assert.deepEqual(await readdir(join(local, 'runs')), []);
    assert.ok((await readdir(local)).includes('runtime.json'));
    await trial(local);
    await releaseRunLock(local, lease.id);
    // Acquiring a lease alone preserves history. Cleanup is explicit for the wrapper.
    const keep = await acquireRunLock(local);
    assert.equal((await readdir(join(local, 'runs'))).length, 1);
    await releaseRunLock(local, keep.id);
  } finally { await rm(local, { recursive: true, force: true }); }
});

test('an active invocation blocks another run and incorrect owners cannot prune or release it', async () => {
  const local = await mkdtemp(join(tmpdir(), 'hb-retention-'));
  try {
    const lease = await acquireRunLock(local);
    assert.equal((await validateRunLock(local, lease.id)).ownerPid, process.pid);
    await assert.rejects(acquireRunLock(local), /Another run/);
    await assert.rejects(pruneRuns(local, randomUUID()), /does not own/);
    await assert.rejects(releaseRunLock(local, randomUUID()), /another invocation/);
    await releaseRunLock(local, lease.id);
    const next = await acquireRunLock(local);
    await releaseRunLock(local, next.id);
  } finally { await rm(local, { recursive: true, force: true }); }
});

test('incomplete directories block cleanup before any completed result is deleted', async () => {
  const local = await mkdtemp(join(tmpdir(), 'hb-retention-'));
  try {
    const complete = await trial(local);
    const incomplete = randomUUID();
    await mkdir(join(local, 'runs', incomplete));
    const lease = await acquireRunLock(local);
    await assert.rejects(pruneRuns(local, lease.id), /Incomplete/);
    assert.deepEqual((await readdir(join(local, 'runs'))).sort(), [complete, incomplete].sort());
    await releaseRunLock(local, lease.id);
  } finally { await rm(local, { recursive: true, force: true }); }
});

test('a linked run store cannot redirect cleanup outside the benchmark', async () => {
  const local = await mkdtemp(join(tmpdir(), 'hb-retention-'));
  const outside = await mkdtemp(join(tmpdir(), 'hb-retention-outside-'));
  try {
    await symlink(outside, join(local, 'runs'), 'junction');
    const lease = await acquireRunLock(local);
    await assert.rejects(pruneRuns(local, lease.id), /real directory/);
    await releaseRunLock(local, lease.id);
  } finally {
    await rm(local, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
