import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { buildConfigJsonSchema, ARRAY_CONFIG_KEYS } from './config-schema';
import { CONFIG_FILE_KEYS } from './config-file';

/**
 * Drift guard for `goalyrc.schema.json` (improvement plan 3.2): the checked-in file must equal
 * what the builder produces from today's `ConfigFileSchema`. Adding a config key without
 * regenerating fails HERE with the fix, instead of shipping an editor schema that rejects a key
 * the run path accepts.
 */
describe('goalyrc.schema.json drift guard', () => {
  const schemaPath = path.join(__dirname, '..', '..', 'goalyrc.schema.json');

  it('the checked-in schema matches the builder — if not, run: npm run gen:schema', () => {
    const onDisk = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
    expect(onDisk).toEqual(buildConfigJsonSchema());
  });

  it('covers every config key, rejects unknown keys, and array-allows only the list keys', () => {
    const schema = buildConfigJsonSchema();
    const properties = schema['properties'] as Record<string, { anyOf: unknown[] }>;
    // The flag-mirror keys plus the one structural key (the named-preset block).
    expect(Object.keys(properties).sort()).toEqual([...CONFIG_FILE_KEYS, 'presets'].sort());
    expect(schema['additionalProperties']).toBe(false);
    for (const key of CONFIG_FILE_KEYS) {
      if (key === 'preset') continue; // a preset NAME (plain string), not a flag-value union
      const allowsArray = properties[key]!.anyOf.some(
        (v) => (v as { type?: string }).type === 'array',
      );
      expect(allowsArray, `${key} array-allowance`).toBe(ARRAY_CONFIG_KEYS.includes(key));
    }
  });

  it('the presets block accepts every flag key except "preset", and rejects unknown keys', () => {
    const schema = buildConfigJsonSchema();
    const presets = (schema['properties'] as Record<string, unknown>)['presets'] as {
      additionalProperties: { properties: Record<string, unknown>; additionalProperties: boolean };
    };
    expect(Object.keys(presets.additionalProperties.properties).sort()).toEqual(
      CONFIG_FILE_KEYS.filter((k) => k !== 'preset').sort(),
    );
    expect(presets.additionalProperties.additionalProperties).toBe(false);
  });
});
