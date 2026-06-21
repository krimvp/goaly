import { spawn, type SpawnOptions } from 'node:child_process';

export type ProcessResult = {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  /** Set when output exceeded `maxOutputBytes` and the process was killed. */
  truncated?: boolean;
};

export type RunProcessOptions = {
  input?: string;
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Cap on captured stdout+stderr bytes before the process is killed (default 16 MB). */
  maxOutputBytes?: number;
};

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Spawn a process, capture stdout/stderr, and resolve (never reject) with the exit code and a
 * timeout flag. Shared by the CLI-backed LLM provider and harness adapters so subprocess
 * handling lives in one tested place.
 */
export function runProcess(
  command: string,
  args: string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const spawnOptions: SpawnOptions = {
    env: options.env ?? process.env,
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
  };

  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise<ProcessResult>((resolve) => {
    const child = spawn(command, args, spawnOptions);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let truncated = false;

    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, options.timeoutMs)
        : null;

    const overCap = (): boolean => stdout.length + stderr.length > maxBytes;

    child.stdout?.on('data', (d: Buffer) => {
      if (truncated) return;
      stdout += d.toString();
      if (overCap()) {
        truncated = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (truncated) return;
      stderr += d.toString();
      if (overCap()) {
        truncated = true;
        child.kill('SIGKILL');
      }
    });
    child.on('error', (e) => {
      if (timer !== null) clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${String(e)}`, code: 127, timedOut, truncated });
    });
    child.on('close', (code) => {
      if (timer !== null) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1, timedOut, truncated });
    });

    if (options.input !== undefined && child.stdin !== null) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}
