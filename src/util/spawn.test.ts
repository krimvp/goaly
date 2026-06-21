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
});
