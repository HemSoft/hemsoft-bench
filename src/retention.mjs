import { mkdir, readFile, writeFile, readdir, lstat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const root = fileURLToPath(new URL('../.local', import.meta.url));
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const lockPath = local => join(local, 'run-lock');

export async function acquireRunLock(local, ownerPid = process.pid) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) throw new Error('Invalid run owner PID.');
  await mkdir(local, { recursive: true });
  const path = lockPath(local);
  try { await mkdir(path); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Another run owns ${path}. If a process crashed, verify it and its containers have stopped before removing this lock directory.`);
    throw error;
  }
  const lease = { id: randomUUID(), ownerPid };
  try { await writeFile(join(path, 'owner.json'), JSON.stringify(lease)); }
  catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  return lease;
}

export async function validateRunLock(local, id) {
  if (!uuid.test(id ?? '')) throw new Error('Invalid invocation ID.');
  const lease = JSON.parse(await readFile(join(lockPath(local), 'owner.json'), 'utf8'));
  if (lease.id !== id) throw new Error('Invocation does not own the run lock.');
  try { process.kill(lease.ownerPid, 0); }
  catch { throw new Error('Invocation owner is no longer running. Refusing to use its lock.'); }
  return lease;
}

export async function releaseRunLock(local, id) {
  // Ownership matching also permits release after the owner's normal exit.
  const lease = JSON.parse(await readFile(join(lockPath(local), 'owner.json'), 'utf8'));
  if (lease.id !== id) throw new Error('Cannot release another invocation\'s lock.');
  await rm(lockPath(local), { recursive: true });
}

export async function pruneRuns(local, id) {
  await validateRunLock(local, id);
  const directory = join(local, 'runs');
  const rootStat = await lstat(directory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) throw new Error('Run store must be a real directory, not a link.');
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const targets = [];
  // Validate the complete deletion set first. Never follow links or delete an
  // unknown/incomplete directory merely because it happens to be in this store.
  for (const entry of entries) {
    if (!entry.isDirectory() || !uuid.test(entry.name)) throw new Error(`Unrecognized artifact: ${entry.name}. No automatic cleanup performed.`);
    const path = join(directory, entry.name);
    const resultPath = join(path, 'result.json');
    let result;
    try {
      if (!(await lstat(resultPath)).isFile()) throw new Error('Not a regular result file');
      result = JSON.parse(await readFile(resultPath, 'utf8'));
    } catch { throw new Error(`Incomplete or invalid run ${entry.name}. Inspect it before cleanup.`); }
    if (result.id !== entry.name || typeof result.status !== 'string') throw new Error(`Unrecognized result ${entry.name}. No automatic cleanup performed.`);
    targets.push(path);
  }
  for (const path of targets) await rm(path, { recursive: true });
  return targets.length;
}

async function main() {
  const [command, value, ...rest] = process.argv.slice(2);
  if (command === 'begin') {
    if (rest.some(arg => arg !== '--keep-history')) throw new Error('Unknown retention option.');
    const lease = await acquireRunLock(root, Number(value));
    try {
      const removed = rest.includes('--keep-history') ? 0 : await pruneRuns(root, lease.id);
      console.log(JSON.stringify({ ...lease, removed }));
    } catch (error) { await releaseRunLock(root, lease.id); throw error; }
  } else if (command === 'end') {
    await releaseRunLock(root, value);
  } else throw new Error('Use begin OWNER_PID [--keep-history] or end INVOCATION_ID.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
