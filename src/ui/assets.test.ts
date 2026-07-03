import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAsset, resolveAssetsDir } from './assets';

describe('static asset serving (traversal-guarded, fail-soft)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'goaly-assets-'));
    await writeFile(join(dir, 'index.html'), '<html>app</html>');
    await writeFile(join(dir, 'app.js'), 'js');
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'x.css'), 'css');
    // A secret OUTSIDE the assets dir that traversal must never reach.
    await writeFile(join(dir, '..', `goaly-secret-${process.pid}`), 'secret');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(join(dir, '..', `goaly-secret-${process.pid}`), { force: true });
  });

  it('serves known extensions with the right content type', async () => {
    expect((await readAsset(dir, '/index.html'))?.contentType).toContain('text/html');
    expect((await readAsset(dir, '/app.js'))?.contentType).toContain('javascript');
    expect((await readAsset(dir, '/sub/x.css'))?.contentType).toContain('text/css');
  });

  it('refuses path traversal out of the assets dir', async () => {
    expect(await readAsset(dir, `/../goaly-secret-${process.pid}`)).toBeNull();
    expect(await readAsset(dir, `/sub/../../goaly-secret-${process.pid}`)).toBeNull();
    expect(await readAsset(dir, '/%2e%2e/etc/passwd')).toBeNull();
  });

  it('refuses unknown extensions and missing files', async () => {
    await writeFile(join(dir, 'x.sh'), 'nope');
    expect(await readAsset(dir, '/x.sh')).toBeNull();
    expect(await readAsset(dir, '/missing.js')).toBeNull();
  });

  it('resolveAssetsDir returns the override when it has an index.html, else null', async () => {
    expect(await resolveAssetsDir(dir)).toBe(dir);
    const empty = await mkdtemp(join(tmpdir(), 'goaly-assets-empty-'));
    try {
      expect(await resolveAssetsDir(empty)).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
