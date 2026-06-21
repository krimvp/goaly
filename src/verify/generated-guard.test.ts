import { describe, it, expect } from 'vitest';
import { GeneratedFilesGuard } from './generated-guard';
import { FakeWorkspace } from '../testing/fakes';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('GeneratedFilesGuard (C1)', () => {
  it('passes when every pinned file still hashes to its frozen value', async () => {
    const ws = new FakeWorkspace();
    ws.setFileHash('parser.test.ts', HASH_A);
    const guard = new GeneratedFilesGuard([{ path: 'parser.test.ts', sha256: HASH_A }]);

    const v = await guard.verify(ws, 'goal', 'rubric');

    expect(v.pass).toBe(true);
    expect(v.confidence).toBe(1);
  });

  it('fails closed when a pinned file was modified since freeze', async () => {
    const ws = new FakeWorkspace();
    ws.setFileHash('parser.test.ts', HASH_B); // worker rewrote the test
    const guard = new GeneratedFilesGuard([{ path: 'parser.test.ts', sha256: HASH_A }]);

    const v = await guard.verify(ws, 'goal', 'rubric');

    expect(v.pass).toBe(false);
    expect(v.confidence).toBe(1);
    expect(v.detail).toContain('modified since the contract was frozen');
    expect(v.detail).toContain('parser.test.ts');
  });

  it('fails closed when a pinned file is missing/deleted', async () => {
    const ws = new FakeWorkspace(); // no hash stubbed → fileHash returns null
    const guard = new GeneratedFilesGuard([{ path: 'gone.test.ts', sha256: HASH_A }]);

    const v = await guard.verify(ws, 'goal', 'rubric');

    expect(v.pass).toBe(false);
    expect(v.detail).toContain('missing or unreadable');
  });

  it('is vacuously green with no pinned files', async () => {
    const v = await new GeneratedFilesGuard([]).verify(new FakeWorkspace(), 'g', 'r');
    expect(v.pass).toBe(true);
  });
});
