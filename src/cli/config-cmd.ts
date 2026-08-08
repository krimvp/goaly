import { readFile } from 'node:fs/promises';
import { overlayFromConfig } from './config-file';
import { UsageError } from './flags/tokens';

/**
 * `goaly config` (improvement plan 3.2): config-file tooling. `validate <path>` parses a config
 * file through the SAME fail-closed path every run uses (`overlayFromConfig`), so "this file
 * validates" and "a run accepts this file" are one fact. The JSON Schema
 * (`goalyrc.schema.json`) is editor sugar; this command is the runtime truth.
 */

export type ConfigCommand = { readonly kind: 'validate'; readonly path: string };

/** Run a `goaly config` subcommand; returns the process exit code (0 valid, 1 invalid, 2 usage). */
export async function runConfig(
  cmd: ConfigCommand,
  out: (s: string) => void,
  err: (s: string) => void,
): Promise<number> {
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
    const overlay = overlayFromConfig(json, cmd.path);
    const keys = Object.keys(overlay);
    out(
      `${cmd.path}: valid (${keys.length} setting${keys.length === 1 ? '' : 's'}${
        keys.length > 0 ? `: ${keys.join(', ')}` : ''
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
