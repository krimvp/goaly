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
  /**
   * Idle (heartbeat) timeout in milliseconds (issue #56): kill the process when NO stdout/stderr
   * activity has arrived for this long, instead of (or in addition to) the hard wall-clock
   * `timeoutMs`. A turn that is actively streaming output keeps resetting it, so a legitimately long
   * but progressing turn survives — only a genuinely stalled one is killed (still flagged
   * `timedOut`). When both are set, `timeoutMs` remains the absolute backstop. A killed-on-idle run
   * is indistinguishable from a wall-clock timeout downstream: both surface as `timedOut: true`.
   */
  idleTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Run the command through a shell (`spawn`'s `shell` option). Used for verify-command strings. */
  shell?: boolean;
  /**
   * Spawn the child in its OWN process group (`detached`) and SIGKILL the whole group (`-pid`) on a
   * timeout / output-cap kill, instead of just the lone child. A shell command is a `sh` wrapper, so
   * killing only the wrapper would orphan its children — and because they inherit the stdio pipes,
   * `close` would never fire and the run would hang forever. Killing the group reaps the wrapper AND
   * its descendants. Default off (kill the lone child); turn on for anything that spawns subprocesses.
   */
  killGroup?: boolean;
  /** Cap on captured stdout+stderr bytes before the process is killed (default 16 MB). */
  maxOutputBytes?: number;
  /**
   * Optional live stdout tap (issue #23): invoked with each raw stdout chunk as it arrives, in
   * addition to the buffered capture returned at the end. Used to feed a streaming `StreamTap`.
   * Guarded so a throwing tap never affects the subprocess result.
   */
  onStdout?: (chunk: string) => void;
};

const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Live children spawned through {@link runProcess}, so a forced shutdown can reap them. */
const activeChildren = new Set<{ pid: number | undefined; killGroup: boolean }>();

/**
 * SIGKILL every child (and, for group-spawned ones, its whole process group) still running.
 * Used by the CLI's force-exit path (second Ctrl-C): a `killGroup` child lives in its OWN process
 * group, so the terminal's SIGINT never reaches it — without this sweep a force-exit would orphan
 * a live agent CLI that keeps editing the tree and spending tokens after goaly is gone.
 */
export function killActiveChildren(): void {
  for (const entry of activeChildren) {
    if (entry.pid === undefined) continue;
    try {
      process.kill(entry.killGroup ? -entry.pid : entry.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

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
    ...(options.shell !== undefined ? { shell: options.shell } : {}),
    ...(options.killGroup === true ? { detached: true } : {}),
  };

  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise<ProcessResult>((resolve) => {
    const child = spawn(command, args, spawnOptions);
    const registryEntry = { pid: child.pid, killGroup: options.killGroup === true };
    activeChildren.add(registryEntry);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let truncated = false;

    /** Kill the whole process group when detached; fall back to the lone child otherwise. */
    const kill = (): void => {
      try {
        if (options.killGroup === true && child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // Process (group) already gone — nothing to kill.
      }
    };

    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, options.timeoutMs)
        : null;

    // Idle/heartbeat timeout (issue #56): re-armed on every output chunk, so a streaming-but-slow
    // turn never trips it; only a genuine stall (no output for `idleTimeoutMs`) kills the process.
    let idleTimer: NodeJS.Timeout | null = null;
    const armIdle = (): void => {
      if (options.idleTimeoutMs === undefined) return;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.idleTimeoutMs);
    };
    const clearTimers = (): void => {
      if (timer !== null) clearTimeout(timer);
      if (idleTimer !== null) clearTimeout(idleTimer);
    };
    armIdle();

    const overCap = (): boolean => stdout.length + stderr.length > maxBytes;

    child.stdout?.on('data', (d: Buffer) => {
      if (truncated) return;
      armIdle();
      const chunk = d.toString();
      stdout += chunk;
      if (options.onStdout !== undefined) {
        // Live tap is diagnostics-only: never let it disturb capture or the subprocess.
        try {
          options.onStdout(chunk);
        } catch {
          /* ignore — a throwing stdout tap must not affect the run */
        }
      }
      if (overCap()) {
        truncated = true;
        kill();
      }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (truncated) return;
      armIdle();
      stderr += d.toString();
      if (overCap()) {
        truncated = true;
        kill();
      }
    });
    child.on('error', (e) => {
      clearTimers();
      activeChildren.delete(registryEntry);
      resolve({ stdout, stderr: `${stderr}${String(e)}`, code: 127, timedOut, truncated });
    });
    child.on('close', (code) => {
      clearTimers();
      activeChildren.delete(registryEntry);
      resolve({ stdout, stderr, code: code ?? 1, timedOut, truncated });
    });

    if (child.stdin !== null) {
      if (options.input !== undefined) child.stdin.write(options.input);
      // ALWAYS close stdin (even with no input): a headless agent CLI that reads stdin — pi reads it
      // even in `--print` mode — blocks waiting for EOF on the inherited pipe until the wall-clock
      // timeout kills it. A CLI that ignores stdin is unaffected. Without this, a `promptOnStdin:false`
      // codec whose tool reads stdin (pi) hangs every turn.
      child.stdin.end();
    }
  });
}
