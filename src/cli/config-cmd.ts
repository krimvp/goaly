import { readFile } from 'node:fs/promises';
import { loadConfig, parseConfigDocument, type LoadedConfig } from './config-file';
import { mergedPresets } from './presets';
import { UsageError } from './flags/tokens';

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
  | { readonly kind: 'presets'; readonly names: boolean };

/** Run a `goaly config` subcommand; returns the process exit code (0 valid, 1 invalid, 2 usage). */
export async function runConfig(
  cmd: ConfigCommand,
  workspace: string,
  out: (s: string) => void,
  err: (s: string) => void,
  load: (dir: string) => Promise<LoadedConfig> = (dir) => loadConfig(dir, undefined),
): Promise<number> {
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
