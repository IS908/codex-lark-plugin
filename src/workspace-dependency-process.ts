import { spawn } from 'node:child_process';

export class WorkspaceDependencyProcessError extends Error {
  constructor(readonly reason: 'spawn' | 'exit' | 'timeout' | 'output' | 'aborted', readonly quiescent: boolean) {
    super('The private dependency process did not complete successfully.');
  }
}

export function runWorkspaceDependencyProcess(launch: { command: string; args: string[]; env: NodeJS.ProcessEnv; isolatesDescendants?: true },
  args: string[], cwd: string, timeoutMs: number, outputLimit: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new WorkspaceDependencyProcessError('aborted', true)); return; }
    const child = spawn(launch.command, [...launch.args, ...args], { cwd, env: launch.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0;
    let stopping: 'timeout' | 'output' | 'aborted' | undefined;
    let grace: NodeJS.Timeout | undefined;
    const stop = (reason: 'timeout' | 'output' | 'aborted') => {
      if (stopping) return;
      stopping = reason;
      clearTimeout(timer);
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch { /* The child may already have stopped. */ } }
      }
      grace = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        reject(new WorkspaceDependencyProcessError(reason, false));
      }, 1000);
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const onAbort = () => stop('aborted');
    signal?.addEventListener('abort', onAbort, { once: true });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > outputLimit) stop('output');
    });
    child.once('error', () => {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      clearTimeout(grace);
      reject(new WorkspaceDependencyProcessError('spawn', !child.pid));
    });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      clearTimeout(grace);
      const quiescent = !stopping && code !== null && launch.isolatesDescendants === true;
      if (quiescent && code === 0) resolve();
      else reject(new WorkspaceDependencyProcessError(stopping ?? 'exit', quiescent));
    });
  });
}
