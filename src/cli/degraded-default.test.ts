import { describe, it, expect } from 'vitest';
import { parseArgs } from './args';
import { loadConfig, type ConfigFileReader, type LoadedConfig } from './config-file';
import type { InputReaders } from './input-sources';
import { resolveModels } from './models';
import { degradedMode } from './independence';

/**
 * Issue #125 end-to-end over the CLI seam: what the DEFAULT run (`goaly "<goal>"` — implied
 * `default` preset ⇒ `--generate --autonomous`) actually resolves to, and what label it earns.
 * This is the exact composition `executeRun` performs before it calls `drive()`, so the resolution
 * and the labelling are pinned together rather than each in isolation.
 */

const homeDir = '/home/test-user';

const readers: InputReaders = {
  readFile: async () => {
    throw new Error('no files in this test');
  },
  readStdin: async () => '',
};

/** A config loader over an empty in-memory tree: no .goalyrc anywhere, so only the built-ins apply. */
const noConfig = (): ((dir: string, explicit: string | undefined) => Promise<LoadedConfig>) => {
  const reader: ConfigFileReader = async () => undefined;
  return (dir, explicit) => loadConfig(dir, explicit, reader, homeDir);
};

async function resolve(argv: string[]) {
  const parsed = await parseArgs(argv, readers, noConfig());
  const models = resolveModels(parsed.models, { llmProvider: parsed.llmProvider });
  const degraded = degradedMode(models, parsed.harness, parsed.llmProvider, {
    generate: parsed.config.verifier.kind === 'generate',
    autonomous: parsed.config.autonomous,
    approverQuorum: parsed.config.approver.quorum,
    ...(models.approverModels !== undefined ? { approverModels: models.approverModels } : {}),
  });
  return { parsed, models, degraded };
}

describe('the default run and the second key (issue #125)', () => {
  it('zero-config `goaly "<goal>"` is labelled SELF-JUDGED (only one model is available)', async () => {
    const { parsed, models, degraded } = await resolve(['ship the parser']);
    // The implied `default` preset is what makes the run self-authored + unattended.
    expect(parsed.config.autonomous).toBe(true);
    expect(parsed.config.verifier.kind).toBe('generate');
    // Nothing to be distinct from: every role is the tool default. Non-blocking — the run proceeds.
    expect(models.approver).toBeUndefined();
    expect(models.approverIndependentFrom).toBeUndefined();
    expect(degraded).toEqual({ kind: 'self-judged', generate: true, autonomous: true });
  });

  it('`--model X` keeps the approver off the agent’s model, but independence stays UNVERIFIED', async () => {
    const { models, degraded } = await resolve(['ship the parser', '--model', 'big-model']);
    expect(models.harness).toBe('big-model');
    expect(models.judge).toBe('big-model');
    expect(models.approver).toBeUndefined(); // the claude provider's own model — id unknown to goaly
    expect(models.approverIndependentFrom).toBe('big-model');
    // goaly asked for a different model; it cannot confirm it GOT one (the provider's default could
    // itself be `big-model`). Labelled as unverified — never as a verified independent second key.
    expect(degraded).toEqual({
      kind: 'independence-unverified',
      model: 'big-model',
      generate: true,
      autonomous: true,
    });
  });

  it('an explicit --approver-model is the independent second key (no label, no auto-swap)', async () => {
    const { models, degraded } = await resolve([
      'ship the parser',
      '--model',
      'big-model',
      '--approver-model',
      'other-model',
    ]);
    expect(models.approver).toBe('other-model');
    expect(models.approverIndependentFrom).toBeUndefined();
    expect(degraded).toBeUndefined();
  });

  it('re-collapsing is still possible on purpose, and is then labelled honestly', async () => {
    const { models, degraded } = await resolve([
      'ship the parser',
      '--model',
      'big-model',
      '--approver-model',
      'big-model',
    ]);
    expect(models.approver).toBe('big-model');
    expect(degraded).toMatchObject({ kind: 'self-judged', model: 'big-model' });
  });

  it('a --verify-cmd run is still labelled when all three roles collapse, but not as self-authored', async () => {
    const { degraded } = await resolve(['ship the parser', '--verify-cmd', 'npm test']);
    expect(degraded).toEqual({ kind: 'self-judged', generate: false, autonomous: true });
  });

  it('a different vendor for the LLM steps is not a collapse at all', async () => {
    const { degraded } = await resolve(['ship the parser', '--llm-provider', 'codex']);
    expect(degraded).toBeUndefined();
  });
});
