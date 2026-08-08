import { readFile } from 'node:fs/promises';
import { loadConfig, parseConfigDocument, type LoadedConfig } from './config-file';
import { mergedPresets } from './presets';
import { UsageError } from './flags/tokens';
import { FileDefectCorpus, type DefectCorpus } from '../defects/corpus';

/**
 * `goaly config` (improvement plan 3.2): config-file tooling. `validate <path>` parses a config
 * file through the SAME fail-closed path every run uses (`parseConfigDocument`), so "this file
 * validates" and "a run accepts this file" are one fact. `presets` lists the named presets exactly
 * as a run in the workspace would resolve them (all layers, wholesale replacement) — the
 * discoverability half of `--preset`; its `--names` form feeds shell completion. The JSON Schema
 * (`goalyrc.schema.json`) is editor sugar; this command is the runtime truth.
 */

export type ConfigCommand =
  | { readonly kind: 'validate'; readonly path: string }
  | { readonly kind: 'presets'; readonly names: boolean }
  /** The cross-run defect corpus (issue #122): inspect it, or reset it. */
  | { readonly kind: 'defects'; readonly action: 'list' | 'clear'; readonly path?: string };

/** Run a `goaly config` subcommand; returns the process exit code (0 valid, 1 invalid, 2 usage). */
export async function runConfig(
  cmd: ConfigCommand,
  workspace: string,
  out: (s: string) => void,
  err: (s: string) => void,
  load: (dir: string) => Promise<LoadedConfig> = (dir) => loadConfig(dir, undefined),
  /** Inject the corpus (tests); default reads the real `--defect-corpus` / `~/.goaly` file. */
  makeCorpus: (path: string | undefined) => DefectCorpus = (p) => new FileDefectCorpus(p),
): Promise<number> {
  if (cmd.kind === 'defects') return runDefects(cmd, out, makeCorpus(cmd.path));
  if (cmd.kind === 'presets') {
    let fromConfig: LoadedConfig['presets'];
    try {
      fromConfig = (await load(workspace)).presets;
    } catch (e) {
      if (e instanceof UsageError) {
        err(`${e.message}\n`);
        return 1;
      }
      throw e;
    }
    // Built-ins included: this lists what `--preset` would actually resolve against.
    const presets = mergedPresets(fromConfig);
    const names = Object.keys(presets).sort();
    if (cmd.names) {
      out(names.map((n) => `${n}\n`).join(''));
      return 0;
    }
    for (const name of names) {
      const p = presets[name]!;
      out(`${name}  (${p.source})  ${Object.keys(p.overlay).join(', ')}\n`);
    }
    out('\ndefine your own under "presets" in .goalyrc; redefining a name replaces it wholesale\n');
    return 0;
  }

  const text = await readFile(cmd.path, 'utf8').then(
    (t) => t,
    () => undefined,
  );
  if (text === undefined) {
    err(`goaly config validate: cannot read '${cmd.path}' (does the file exist?)\n`);
    return 2;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    err(`${cmd.path}: not valid JSON — ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  try {
    const doc = parseConfigDocument(json, cmd.path);
    const keys = Object.keys(doc.overlay);
    const presetNames = Object.keys(doc.presets);
    out(
      `${cmd.path}: valid (${keys.length} setting${keys.length === 1 ? '' : 's'}${
        keys.length > 0 ? `: ${keys.join(', ')}` : ''
      }${
        presetNames.length > 0
          ? `; ${presetNames.length} preset${presetNames.length === 1 ? '' : 's'}: ${presetNames.join(', ')}`
          : ''
      })\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      err(`${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

/**
 * `goaly config defects list|clear` (issue #122): the operator's window onto the one piece of
 * cross-run state goaly keeps. `list` prints every recorded false-red pattern with its
 * language/runner and provenance (so "which hidden local state is shaping my contracts?" is one
 * command away); `clear` resets the file. Read-only and fail-open like the corpus itself — a
 * missing or corrupt file lists as empty rather than erroring, and neither action can ever ADD a
 * record: only an adjudicated CONTRACT_DEFECTIVE verdict writes.
 */
async function runDefects(
  cmd: { readonly action: 'list' | 'clear' },
  out: (s: string) => void,
  corpus: DefectCorpus,
): Promise<number> {
  if (cmd.action === 'clear') {
    await corpus.clear();
    out(`cleared the defect corpus at ${corpus.path}\n`);
    return 0;
  }
  const records = corpus.read();
  if (records.length === 0) {
    out(`no recorded defects (${corpus.path})\n`);
    return 0;
  }
  out(`${records.length} recorded defect${records.length === 1 ? '' : 's'} (${corpus.path}):\n`);
  for (const r of records) {
    out(`  [${r.ts}] ${r.language}/${r.runner}  ${r.pattern}\n`);
    if (r.assertionShape !== undefined) out(`      assertion shape: ${r.assertionShape}\n`);
    out(`      from run ${r.runId}, contract ${r.contractHash.slice(0, 12)}\n`);
  }
  out('\nonly an adjudicated CONTRACT_DEFECTIVE verdict can add to this; clear it with: goaly config defects clear\n');
  return 0;
}
