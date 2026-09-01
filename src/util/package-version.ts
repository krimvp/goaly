import { readFile } from 'node:fs/promises';

/**
 * Reads goaly's own `package.json` version, searching relative to the calling module's compiled
 * location so it works both from `src` (dev, one `../` from `src/<dir>/`) and from the bundled
 * `dist/goaly.js` (one `../` from `dist/`). 'unknown' when the manifest can't be found or parsed.
 */
export async function readPackageVersion(fromUrl: string): Promise<string> {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const raw = await readFile(new URL(rel, fromUrl), 'utf8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === 'goaly') return parsed.version ?? 'unknown';
    } catch {
      /* try the next location */
    }
  }
  return 'unknown';
}
