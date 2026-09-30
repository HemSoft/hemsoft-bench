import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export function piCommand() {
  const entry = process.env.HB_PI_ENTRY ?? (process.platform === 'win32' ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js') : null);
  if (!entry) return { command: 'pi', prefix: [] };
  if (!existsSync(entry)) throw new Error('Pi CLI entry not found. Set HB_PI_ENTRY to the installed Pi cli.js.');
  return { command: process.execPath, prefix: [entry] };
}

// No shell interpolation. Bounded buffers, cancellation and process-tree cleanup.
export function run(command, args, { input = '', cwd, env = process.env, timeoutMs = 30_000, maxBytes = 1024 * 1024, signal, onStdout, onStderr, onStop } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Process aborted before launch.'));
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe','pipe','pipe'] });
    const stdout = [], stderr = [];
    let size = 0, failure, observerError;
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
      else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    };
    const stop = reason => {
      if (!failure) {
        failure = reason;
        // Notify the child before potentially slow Windows process-tree termination.
        try { onStop?.(reason); } catch (error) { observerError ??= error.message; }
        kill();
      }
    };
    const timer = timeoutMs===null?null:setTimeout(() => stop('timeout'), timeoutMs);
    const abort = () => stop('aborted');
    signal?.addEventListener('abort', abort, {once:true});
    const cleanup = () => { if(timer!==null)clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.on('error', e => { cleanup(); reject(e); });
    for (const [stream, target, observer] of [[child.stdout, stdout, onStdout], [child.stderr, stderr, onStderr]]) {
      stream.on('data', chunk => {
        size += chunk.length;
        if (size <= maxBytes) {
          target.push(chunk);
          if (!observerError) {
            try { observer?.(chunk); }
            catch (error) { observerError = error.message; stop('output_observer_error'); }
          }
        } else stop('output_limit');
      });
    }
    child.stdin.on('error', () => {}); // Early exit can close stdin before end.
    child.stdin.end(input);
    child.on('close', code => {
      cleanup();
      resolve({ code, failure: failure ?? null, ...(observerError ? {observerError} : {}), stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}

export async function checked(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0 || result.failure) throw new Error(`${command} failed: ${result.failure ?? result.code}\n${result.stderr.slice(0, 2000)}`);
  return result.stdout;
}
