import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export const STARTER_SOURCE = '# Implement the contract in TASK.md.\nraise NotImplementedError("Implement solution.py")\n';
export const RECOVERABLE_STATUSES = new Set([
  'provider_error', 'timeout', 'estimated_cost_limit', 'request_limit',
  'aborted', 'incomplete', 'output_limit', 'output_observer_error', 'infrastructure_error',
]);

// Copies only the current regular file as untrusted text. Never executes it on
// the host or feeds hidden grading results back into the candidate conversation.
export async function recoverSubmission(sandbox, directory, grade, reason, starter=STARTER_SOURCE) {
  const recovery = {kind:'interrupted_snapshot', reason, state:'capture_failed'};
  let source;
  try {
    source = await sandbox.submission();
    if (source === starter) return {...recovery, state:'unchanged_starter'};
    await writeFile(join(directory,'submission.py'), source);
    recovery.sourceFile = 'submission.py';
    recovery.sourceHash = createHash('sha256').update(source).digest('hex');
  } catch(error) { return {...recovery, error:error.message}; }
  // Stop all candidate processes before creating a fresh grading sandbox.
  try { await sandbox.dispose(); }
  catch(error) { return {...recovery, state:'cleanup_failed', error:error.message}; }
  try { return {...recovery, state:'graded', grade:await grade(source)}; }
  catch(error) { return {...recovery, state:'grading_failed', error:error.message}; }
}
