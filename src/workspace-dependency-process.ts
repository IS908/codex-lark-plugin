import { spawn } from 'node:child_process';

export class WorkspaceDependencyProcessError extends Error {
  constructor(readonly reason: 'spawn' | 'exit' | 'timeout' | 'output', readonly quiescent: boolean) {
    super('The private dependency process did not complete successfully.');
  }
}

export function runWorkspaceDependencyProcess(launch: { command: string; args: string[]; env: NodeJS.ProcessEnv },
  args: string[], cwd: string, timeoutMs: number, outputLimit: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, [...launch.args, ...args], { cwd, env: launch.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let size = 0;
    let stopping: 'timeout' | 'output' | undefined;
    let grace: NodeJS.Timeout | undefined;
    const stop = (reason: 'timeout' | 'output') => {
      if (stopping) return;
      stopping = reason;
      clearTimeout(timer);
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch { try { child.kill('SIGKILL'); } catch { /* The child may already have stopped. */ } }
      }
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        reject(new WorkspaceDependencyProcessError(reason, false));
      }, 1000);
    };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > outputLimit) stop('output');
    });
    child.once('error', () => {
      clearTimeout(timer);
      clearTimeout(grace);
      reject(new WorkspaceDependencyProcessError('spawn', !child.pid));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(grace);
      if (!stopping && code === 0) resolve();
      else reject(new WorkspaceDependencyProcessError(stopping ?? 'exit', true));
    });
  });
}
