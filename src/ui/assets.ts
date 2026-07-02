import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, normalize, resolve, sep } from 'node:path';

/**
 * Static serving for the built SPA (`dist/ui/`). Fail-soft by design: when the assets are missing
 * (a dev checkout that hasn't run `npm run build`) the JSON API still works and `GET /` explains
 * how to build — the server never refuses to start over presentation files.
 */

/** A resolved static file, ready to write. */
export type Asset = { body: Buffer; contentType: string };

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

/**
 * Locate the built UI assets. Probes, in order:
 *  1. `./ui/` next to this module — where the bundled CLI (`dist/goaly.js`) finds `dist/ui/`;
 *  2. `../../dist/ui/` — where a `tsx src/cli/bin.ts` dev run (this file at `src/ui/`) finds a
 *     previously-built bundle.
 * Returns null when neither exists (API-only mode).
 */
export async function resolveAssetsDir(override?: string): Promise<string | null> {
  const candidates =
    override !== undefined
      ? [override]
      : [
          fileURLToPath(new URL('./ui/', import.meta.url)),
          fileURLToPath(new URL('../../dist/ui/', import.meta.url)),
        ];
  for (const dir of candidates) {
    try {
      await stat(join(dir, 'index.html'));
      return dir;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Read one asset by URL path, traversal-guarded: the resolved file must stay under the assets dir
 * (the URL path is normalized first, so `..` segments cannot escape). Returns null for a miss —
 * the router then falls back to `index.html` for SPA routes or 404s.
 */
export async function readAsset(assetsDir: string, urlPath: string): Promise<Asset | null> {
  const rel = normalize(urlPath).replace(/^([/\\])+/, '');
  const path = resolve(assetsDir, rel);
  if (path !== resolve(assetsDir) && !path.startsWith(resolve(assetsDir) + sep)) return null;
  const ext = path.slice(path.lastIndexOf('.'));
  const contentType = CONTENT_TYPES[ext];
  if (contentType === undefined) return null; // unknown extension: never serve it
  try {
    return { body: await readFile(path), contentType };
  } catch {
    return null;
  }
}
