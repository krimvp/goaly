import { describe, it, expect } from 'vitest';
import { performRefreeze, applySealEditPatch } from './refreeze';
import { makeFakeContract } from '../testing/fakes';
import { freezeContract, sha256Hex } from '../util/hash';
import type { UnhashedContract } from '../domain/contract';

const base: UnhashedContract = {
  goal: 'g',
  rungs: [
    { kind: 'deterministic', command: 'npm test' },
    { kind: 'judge', rubric: 'meets the goal', quorum: 1, confidenceFloor: 0.5 },
    { kind: 'deterministic', command: 'node smoke.mjs' },
  ],
  setup: 'npm ci',
  requiredTools: ['node'],
  rubric: 'overall rubric',
  generatedFiles: [],
};

describe('applySealEditPatch — pure, total, fail-closed', () => {
  it('no patch is the identity', () => {
    const result = applySealEditPatch(base, undefined);
    expect(result).toEqual({ ok: true, contract: base });
  });

  it('replaces setup, clears it with null, keeps it when absent', () => {
    const replaced = applySealEditPatch(base, { setup: 'make deps' });
    expect(replaced.ok && replaced.contract.setup).toBe('make deps');
    const cleared = applySealEditPatch(base, { setup: null });
    expect(cleared.ok && 'setup' in cleared.contract).toBe(false);
    const kept = applySealEditPatch(base, { rubric: 'new' });
    expect(kept.ok && kept.contract.setup).toBe('npm ci');
  });

  it('replaces the rubric and deterministic rung commands by index', () => {
    const result = applySealEditPatch(base, {
      rubric: 'tighter',
      commands: [
        { index: 0, command: 'npm test -- --run' },
        { index: 2, command: 'node smoke.mjs --strict' },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.rubric).toBe('tighter');
      expect(result.contract.rungs[0]).toMatchObject({ command: 'npm test -- --run' });
      expect(result.contract.rungs[1]).toMatchObject({ kind: 'judge' }); // untouched
      expect(result.contract.rungs[2]).toMatchObject({ command: 'node smoke.mjs --strict' });
    }
  });

  it('refuses a judge-rung index and an out-of-range index (never a silent partial apply)', () => {
    expect(applySealEditPatch(base, { commands: [{ index: 1, command: 'x' }] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not a deterministic rung'),
    });
    expect(applySealEditPatch(base, { commands: [{ index: 9, command: 'x' }] })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('out of range'),
    });
  });
});

describe('performRefreeze — re-pin authored files + apply the patch + re-freeze', () => {
  const files = new Map<string, string>();
  const workspace = { readFile: async (p: string) => files.get(p) ?? null };

  it('re-pins each generated file from its CURRENT content, moving sha256 AND contractHash', async () => {
    const contract = makeFakeContract({
      generatedFiles: [{ path: 'test/gen.test.mjs', sha256: sha256Hex('original content') }],
    });
    files.set('test/gen.test.mjs', 'edited content');

    const result = await performRefreeze(workspace, contract, undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.contract.generatedFiles[0]?.sha256).toBe(sha256Hex('edited content'));
      expect(result.contract.contractHash).not.toBe(contract.contractHash);
      expect(result.contract.goal).toBe(contract.goal); // everything else intact
    }
  });

  it('is a fixpoint on unchanged content with no patch (identical contractHash)', async () => {
    const content = 'stable content';
    const contract = makeFakeContract({
      generatedFiles: [{ path: 'gen.mjs', sha256: sha256Hex(content) }],
    });
    files.set('gen.mjs', content);
    const result = await performRefreeze(workspace, contract, undefined);
    expect(result.ok && result.contract.contractHash).toBe(contract.contractHash);
  });

  it('a missing/unreadable authored file fails closed with the path named', async () => {
    const contract = makeFakeContract({
      generatedFiles: [{ path: 'gone.mjs', sha256: sha256Hex('x') }],
    });
    files.delete('gone.mjs');
    const result = await performRefreeze(workspace, contract, undefined);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('gone.mjs') });
  });

  it('an invalid patch fails the whole refreeze closed', async () => {
    const contract = makeFakeContract();
    const result = await performRefreeze(workspace, contract, {
      commands: [{ index: 99, command: 'x' }],
    });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('out of range') });
  });

  it('field patches move the contractHash exactly like freezeContract would', async () => {
    const contract = makeFakeContract();
    const result = await performRefreeze(workspace, contract, { rubric: 'patched rubric' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const { contractHash: _h, ...unhashed } = contract;
      const expected = freezeContract({ ...unhashed, rubric: 'patched rubric' });
      expect(result.contract.contractHash).toBe(expected.contractHash);
    }
  });
});
