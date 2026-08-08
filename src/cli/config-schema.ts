import { CONFIG_FILE_KEYS } from './config-file';

/**
 * The JSON Schema for `.goalyrc` (improvement plan 3.2), derived from the SAME key list the Zod
 * schema enforces (`CONFIG_FILE_KEYS`) so it structurally cannot name a key the run path would
 * reject. The generated `goalyrc.schema.json` (repo root, shipped in the npm tarball and `dist/`)
 * gives editors auto-completion and validation; the Zod seam remains the runtime authority.
 *
 * Kept as a PURE builder so the drift test can diff the checked-in file against this function —
 * adding a key to `ConfigFileSchema` without regenerating the schema file fails the suite with
 * the fix (`npm run gen:schema`) in the message.
 */

/** Config keys that also accept a JSON array of strings (normalized to the comma-joined wire form). */
export const ARRAY_CONFIG_KEYS: readonly string[] = ['approver-models', 'approver-lenses'];

const FLAG_VALUE = [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] as const;

/** Build the `.goalyrc` JSON Schema object (deterministic key order: `CONFIG_FILE_KEYS` order). */
export function buildConfigJsonSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of CONFIG_FILE_KEYS) {
    properties[key] = ARRAY_CONFIG_KEYS.includes(key)
      ? {
          description: `Default for the --${key} flag (JSON array of strings, or the comma-separated string the CLI accepts).`,
          anyOf: [{ type: 'array', items: { type: 'string' } }, ...FLAG_VALUE],
        }
      : {
          description: `Default for the --${key} flag. Explicit CLI flags always override.`,
          anyOf: [...FLAG_VALUE],
        };
  }
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://github.com/krimvp/goaly/goalyrc.schema.json',
    title: 'goaly config file (.goalyrc)',
    description:
      'Default CLI flags for goaly runs, keyed by kebab-case flag name. ' +
      'Resolution order: tool default < ~/.goalyrc < <workspace>/.goalyrc < --config file < CLI flag. ' +
      'Booleans are presence-style: true sets the flag, false means "not set". ' +
      'Unknown keys are a hard usage error (fail-closed).',
    type: 'object',
    properties,
    additionalProperties: false,
  };
}
