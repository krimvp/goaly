import { describe, it, expect } from 'vitest';
import { runProcess } from './spawn';

describe('runProcess', () => {
  it('captures stdout and a zero exit code', async () => {
    const r = await runProcess('node', ['-e', "process.stdout.write('hi')"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('hi');
    expect(r.timedOut).toBe(false);
  });

  it('reports a non-zero exit code without rejecting', async () => {
    const r = await runProcess('node', ['-e', 'process.exit(3)']);
    expect(r.code).toBe(3);
  });

  it('writes input to stdin', async () => {
    const script =
      "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>process.stdout.write(s.toUpperCase()))";
    const r = await runProcess('node', ['-e', script], { input: 'abc' });
    expect(r.stdout).toBe('ABC');
  });

  it('flags a timeout and kills the process', async () => {
    const r = await runProcess('node', ['-e', 'setTimeout(()=>{}, 10000)'], { timeoutMs: 100 });
    expect(r.timedOut).toBe(true);
  });

  it('resolves (does not reject) when the command is missing', async () => {
    const r = await runProcess('definitely-not-a-real-binary-xyz', []);
    expect(r.code).toBe(127);
  });

  it('taps stdout chunks live via onStdout while still buffering the full capture', async () => {
    const chunks: string[] = [];
    const r = await runProcess('node', ['-e', "process.stdout.write('abc')"], {
      onStdout: (c) => chunks.push(c),
    });
    expect(r.stdout).toBe('abc');
    expect(chunks.join('')).toBe('abc');
  });

  it('a throwing onStdout tap never disturbs the captured result', async () => {
    const r = await runProcess('node', ['-e', "process.stdout.write('safe')"], {
      onStdout: () => {
        throw new Error('tap exploded');
      },
    });
    expect(r.stdout).toBe('safe');
    expect(r.code).toBe(0);
  });

  it('caps output and flags truncated, killing the process', async () => {
    const r = await runProcess(
      'node',
      ['-e', "setInterval(() => process.stdout.write('x'.repeat(1000)), 0)"],
      { maxOutputBytes: 2000 },
    );
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  it('runs a command through a shell when shell is set', async () => {
    const r = await runProcess('echo shelled', [], { shell: true });
    expect(r.stdout.trim()).toBe('shelled');
  });

  it('idle timeout kills a silent (no-output) process and flags it timedOut (issue #56)', async () => {
    // The process emits nothing and sleeps far past the idle window, so the heartbeat timer fires.
    const r = await runProcess('node', ['-e', 'setTimeout(()=>{}, 10000)'], { idleTimeoutMs: 150 });
    expect(r.timedOut).toBe(true);
  });

  it('idle timeout does NOT kill a process that keeps streaming output (issue #56)', async () => {
    // Emits a chunk every 40ms for ~320ms total — longer than the 200ms idle window, but no single
    // gap exceeds it, so each chunk re-arms the heartbeat and the turn runs to a clean exit. A
    // wall-clock cap of 200ms would have killed this progressing turn; the idle cap does not.
    const script =
      "let n=0;const i=setInterval(()=>{process.stdout.write('.');if(++n>=8){clearInterval(i);process.exit(0);}},40);";
    const r = await runProcess('node', ['-e', script], { idleTimeoutMs: 200 });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBe(8);
  });

  it('closes the child stdin when no input is given, so a stdin-reading child gets EOF (not a hang)', async () => {
    // A headless agent CLI that reads stdin (e.g. pi, even in --print mode) would block on the
    // inherited stdin pipe forever if it were left open — every turn would run to the wall-clock
    // timeout. `cat` reads stdin to EOF then exits; with stdin closed it exits 0 promptly. A short
    // timeout proves it did NOT hang waiting for input.
    const r = await runProcess('cat', [], { timeoutMs: 3000 });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  });

  it('killGroup + timeout reaps an orphaning shell that backgrounds a child without hanging', async () => {
    // The shell backgrounds a long sleeper that inherits stdout. Without a process-GROUP kill, the
    // sleeper would keep the inherited stdout pipe open and `close` would never fire — the call would
    // hang. With killGroup the whole group is reaped and the run resolves promptly as timedOut.
    const r = await runProcess('sleep 30 & sleep 30', [], {
      shell: true,
      killGroup: true,
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
  });
});
