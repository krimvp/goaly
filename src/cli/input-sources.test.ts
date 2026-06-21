import { describe, it, expect, vi } from 'vitest';
import { resolveInputSources, type InputReaders } from './input-sources';
import { UsageError } from './args';

function readers(opts: {
  files?: Record<string, string>;
  stdin?: string;
  onStdin?: () => void;
}): InputReaders {
  return {
    readFile: async (p) => {
      const f = opts.files?.[p];
      if (f === undefined) throw new Error(`ENOENT: '${p}'`);
      return f;
    },
    readStdin: async () => {
      opts.onStdin?.();
      return opts.stdin ?? '';
    },
  };
}

describe('resolveInputSources', () => {
  it('returns nothing and reads nothing when no field is sourced', async () => {
    const onStdin = vi.fn();
    const out = await resolveInputSources({}, readers({ onStdin }));
    expect(out).toEqual({});
    expect(onStdin).not.toHaveBeenCalled();
  });

  it('passes an inline value through untouched', async () => {
    const out = await resolveInputSources({ goal: 'do x' }, readers({}));
    expect(out.goal).toBe('do x');
  });

  it('reads a file and trims the trailing newline', async () => {
    const out = await resolveInputSources(
      { 'goal-file': 'g.md' },
      readers({ files: { 'g.md': 'line1\nline2\n' } }),
    );
    expect(out.goal).toBe('line1\nline2');
  });

  it('reads stdin once for "--goal -"', async () => {
    const onStdin = vi.fn();
    const out = await resolveInputSources(
      { goal: '-' },
      readers({ stdin: 'piped\n', onStdin }),
    );
    expect(out.goal).toBe('piped');
    expect(onStdin).toHaveBeenCalledTimes(1);
  });

  it('resolves goal, intent, and rubric independently', async () => {
    const out = await resolveInputSources(
      { goal: 'g', 'intent-file': 'i', rubric: 'r' },
      readers({ files: { i: 'authored intent' } }),
    );
    expect(out).toEqual({ goal: 'g', intent: 'authored intent', rubric: 'r' });
  });

  it('rejects a field with more than one source', async () => {
    await expect(
      resolveInputSources({ goal: 'x', 'goal-file': 'g.md' }, readers({ files: { 'g.md': 'y' } })),
    ).rejects.toThrow(UsageError);
  });

  it('rejects stdin feeding more than one field', async () => {
    await expect(
      resolveInputSources({ goal: '-', intent: '-' }, readers({ stdin: 'x' })),
    ).rejects.toThrow(UsageError);
  });

  it('maps a file-read failure to a UsageError', async () => {
    await expect(
      resolveInputSources({ 'goal-file': 'missing' }, readers({ files: {} })),
    ).rejects.toThrow(UsageError);
  });

  it('rejects a value-less flag (e.g. a bare --goal)', async () => {
    await expect(resolveInputSources({ goal: true }, readers({}))).rejects.toThrow(UsageError);
  });
});
