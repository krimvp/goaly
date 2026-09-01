import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { readPackageVersion } from './package-version';

describe('readPackageVersion', () => {
  it('finds goaly\'s own version from a src module URL', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(await readPackageVersion(import.meta.url)).toBe(manifest.version);
  });

  it("returns 'unknown' when no goaly manifest is reachable", async () => {
    expect(await readPackageVersion('file:///no/such/dir/deep/module.js')).toBe('unknown');
  });
});
