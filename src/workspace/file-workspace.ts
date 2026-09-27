import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve, relative, sep, isAbsolute } from 'node:path';
import { z } from 'zod';
import { DiffHash } from '../domain/ids';
import { errorMessage } from '../util/errors';
import { sha256Hex } from '../util/hash';
import { realExec, type ExecFn } from './git-workspace';
import { augmentToolPath, scrubEnv } from './scrub-env';
import type { CommandResult, Workspace } from './workspace';

/**
 * A file-system-backed {@link Workspace} that does not require git. It maintains a
 * content-addressed snapshot of tracked file bytes under `.goaly/baselines/`
 * so diffing, checkpointing, and resume work without git plumbing.
 *
 * This is the non-git implementation behind the `Workspace` seam (ADR 0018). The
 * orchestrator and driver cannot tell whether they are talking to `GitWorkspace` or
 * `FileWorkspace`.
 */

/** Conventional `timeout(1)` exit code; surfaced when we kill a command for exceeding `timeoutMs`. */
const TIMEOUT_EXIT_CODE = 124;

/** Exit code reported when the spawn itself threw — the command never ran (matches `GitWorkspace`). */
const SPAWN_FAILED_EXIT_CODE = 127;

type Manifest = ReadonlyMap<string, Buffer>;
const Baseline = z.object({ version: z.literal(2), files: z.record(z.string()) });
const LegacyBaseline = z.record(z.string().regex(/^[a-f0-9]{64}$/));
const hashBytes = (content: Buffer): string => createHash('sha256').update(content).digest('hex');

export class LegacyFileBaselineError extends Error {
  constructor() {
    super('Cannot resume this file-mode checkpoint: its legacy hash-only baseline has no file content. Start a new run.');
    this.name = 'LegacyFileBaselineError';
  }
}

/** Paths that never count as implementation source for {@link FileWorkspace.isEmptyOfSource}. */
function isDocOrMeta(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  return (
    /^README/i.test(base) ||
    /^LICENSE/i.test(base) ||
    /\.md$/i.test(base) ||
    base.startsWith('.goaly')
  );
}

function normalizeRel(p: string): string {
  const t = p.trim();
  return t.startsWith('./') ? t.slice(2) : t;
}

function isWithinRoot(root: string, full: string): boolean {
  const path = relative(resolve(root), full);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Hash a manifest deterministically (sorted paths, sha256 content hashes). */
function hashManifest(manifest: Manifest): string {
  const entries = [...manifest.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256Hex(entries.map(([p, content]) => `${p}:${hashBytes(content)}`).join('\n'));
}

/** Serialize a manifest to a deterministic JSON string. */
function manifestToJson(manifest: Manifest): string {
  const obj: Record<string, string> = {};
  for (const [p, content] of [...manifest.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    obj[p] = content.toString('base64');
  }
  return JSON.stringify({ version: 2, files: obj }, null, 2);
}

/** Parse a manifest from JSON. */
function manifestFromJson(text: string): Manifest {
  const raw: unknown = JSON.parse(text);
  if (LegacyBaseline.safeParse(raw).success) throw new LegacyFileBaselineError();
  const parsed = Baseline.parse(raw);
  const manifest = new Map<string, Buffer>();
  for (const [path, encoded] of Object.entries(parsed.files)) {
    if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('Invalid baseline path');
    const content = Buffer.from(encoded, 'base64');
    if (content.toString('base64') !== encoded) throw new Error('Invalid baseline content');
    manifest.set(path, content);
  }
  return manifest;
}

/** Empty manifest hash — the default baseline for a tree with no prior snapshot. */
const EMPTY_MANIFEST_HASH = hashManifest(new Map());

async function walk(root: string, excludes: readonly string[]): Promise<Manifest> {
  const manifest = new Map<string, Buffer>();
  const patterns = excludes.map((raw) => {
    const value = normalizeRel(raw).replace(/\/$/, '');
    const escaped = value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*');
    return { value, glob: new RegExp(`^${escaped}$`) };
  });
  const excluded = (path: string): boolean =>
    path === '.goaly' || path.startsWith('.goaly/') ||
    patterns.some(({ value, glob }) => glob.test(path) || path.startsWith(`${value}/`));

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = normalizeRel(relative(root, full));
      if (excluded(rel)) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        manifest.set(rel, await readFile(full));
      }
    }
  }

  await visit(root);
  return manifest;
}

/** Render a unified-diff-style textual diff between two manifests. */
function renderDiff(prev: Manifest, next: Manifest): string {
  const contentLines = (content: Buffer): string[] => {
    const text = content.toString('utf-8');
    if (text === '') return [];
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    return lines;
  };
  const span = (count: number): string => `${count === 0 ? 0 : 1},${count}`;
  const allPaths = new Set([...prev.keys(), ...next.keys()]);
  const sorted = [...allPaths].sort();
  const lines: string[] = [];
  const pushContent = (prefix: string, content: Buffer): void => {
    for (const line of contentLines(content)) lines.push(`${prefix}${line}`);
    if (content.length > 0 && content[content.length - 1] !== 0x0a) {
      lines.push('\\ No newline at end of file');
    }
  };
  for (const p of sorted) {
    const oldContent = prev.get(p);
    const newContent = next.get(p);
    if (oldContent !== undefined && newContent !== undefined && oldContent.equals(newContent)) continue;
    if (oldContent === undefined && newContent === undefined) continue;
    if ([oldContent, newContent].some((c) => c !== undefined && Buffer.from(c.toString('utf-8')).compare(c) !== 0)) {
      lines.push(`Binary files a/${p} and b/${p} differ`);
      continue;
    }
    if (oldContent === undefined) {
      const addedLines = contentLines(newContent!);
      lines.push(`--- /dev/null`, `+++ b/${p}`);
      lines.push(`@@ -0,0 +${span(addedLines.length)} @@`);
      pushContent('+', newContent!);
    } else if (newContent === undefined) {
      const oldLines = contentLines(oldContent);
      lines.push(`--- a/${p}`, `+++ /dev/null`, `@@ -${span(oldLines.length)} +0,0 @@`);
      pushContent('-', oldContent);
    } else {
      const oldLines = contentLines(oldContent);
      const newLines = contentLines(newContent);
      lines.push(`--- a/${p}`, `+++ b/${p}`);
      lines.push(`@@ -${span(oldLines.length)} +${span(newLines.length)} @@`);
      pushContent('-', oldContent);
      pushContent('+', newContent);
    }
  }
  return lines.join('\n');
}

export class FileWorkspace implements Workspace {
  readonly #root: string;
  readonly #exec: ExecFn;
  readonly #excludes: readonly string[];
  #baseline = EMPTY_MANIFEST_HASH;
  #diffIncludes: readonly string[] = [];

  constructor(
    root: string,
    exec: ExecFn = realExec,
    excludes: readonly string[] = ['.goaly'],
  ) {
    this.#root = root;
    this.#exec = exec;
    this.#excludes = excludes;
  }

  #baselineDir(): string {
    return join(this.#root, '.goaly', 'baselines');
  }

  #baselineFile(hash: string): string {
    return join(this.#baselineDir(), `${hash}.json`);
  }

  async #loadBaseline(hash: string): Promise<Manifest> {
    if (hash === EMPTY_MANIFEST_HASH) return new Map();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid baseline hash');
    const text = await readFile(this.#baselineFile(hash), 'utf-8');
    const manifest = manifestFromJson(text);
    if (hashManifest(manifest) !== hash) throw new Error('Baseline content does not match its hash');
    return manifest;
  }

  async #saveBaseline(hash: string, manifest: Manifest): Promise<void> {
    const dir = this.#baselineDir();
    await mkdir(dir, { recursive: true });
    await writeFile(this.#baselineFile(hash), manifestToJson(manifest), 'utf-8');
  }

  async diffHash(): Promise<DiffHash> {
    const m = await walk(this.#root, this.#excludes);
    return DiffHash.parse(hashManifest(m));
  }

  currentBaseline(): string {
    return this.#baseline;
  }

  setBaseline(ref: string): void {
    this.#baseline = ref;
  }

  setDiffIncludes(paths: readonly string[]): void {
    this.#diffIncludes = paths.map(normalizeRel);
  }

  async checkpoint(): Promise<DiffHash> {
    const m = await walk(this.#root, this.#excludes);
    const hash = hashManifest(m);
    await this.#saveBaseline(hash, m);
    this.#baseline = hash;
    return DiffHash.parse(hash);
  }

  async diff(baseline?: string): Promise<string> {
    const next = await walk(this.#root, this.#excludes);
    const baseHash = baseline ?? this.#baseline;
    const base = await this.#loadBaseline(baseHash);
    const raw = renderDiff(base, next);

    // Include any paths the caller forced into the diff (authored verification files).
    const extra: string[] = [];
    for (const p of this.#diffIncludes) {
      if (!base.has(p) && next.has(p) && !raw.includes(p)) {
        extra.push(`--- /dev/null\n+++ b/${p}\n@@ -0,0 +1 @@\n+  ${p}`);
      }
    }
    const rendered = extra.length > 0 ? `${raw}\n\n${extra.join('\n')}` : raw;
    return rendered;
  }

  async run(command: string, opts?: { timeoutMs?: number }): Promise<CommandResult> {
    // Honor the Workspace "never rejects" contract even if the injected exec throws.
    try {
      const r = await this.#exec('sh', ['-c', command], {
        cwd: this.#root,
        env: augmentToolPath(scrubEnv(process.env)),
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      return {
        exitCode: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        // The same could-not-evaluate facts `GitWorkspace.run` propagates — this is the SECOND
        // implementation of one seam and the verifier cannot tell which one it called. Both flags
        // are things goaly KILLED the command for, and both leave an ordinary-looking non-zero exit
        // behind: dropping either turns a could-not-evaluate outcome into a bogus code red.
        ...(r.timedOut === true ? { timedOut: true } : {}),
        ...(r.outputCapped === true ? { outputCapped: true } : {}),
      };
    } catch (e) {
      // The spawn itself threw — goaly could not even start the command (it never ran).
      return {
        exitCode: SPAWN_FAILED_EXIT_CODE,
        stdout: '',
        stderr: errorMessage(e),
        spawnFailed: true,
      };
    }
  }

  async fileHash(relPath: string): Promise<string | null> {
    const normalized = normalizeRel(relPath);
    const full = resolve(this.#root, normalized);
    if (!isWithinRoot(this.#root, full)) return null;
    try {
      const content = await readFile(full);
      return hashBytes(content);
    } catch {
      return null;
    }
  }

  async readFile(relPath: string): Promise<string | null> {
    const normalized = normalizeRel(relPath);
    const full = resolve(this.#root, normalized);
    if (!isWithinRoot(this.#root, full)) return null;
    try {
      return await readFile(full, 'utf-8');
    } catch {
      return null;
    }
  }

  async isEmptyOfSource(generatedFiles: readonly string[]): Promise<boolean> {
    let m: Manifest;
    try {
      m = await walk(this.#root, this.#excludes);
    } catch {
      return false;
    }
    const generatedSet = new Set(generatedFiles.map(normalizeRel));
    for (const p of m.keys()) {
      if (generatedSet.has(p) || isDocOrMeta(p)) continue;
      return false;
    }
    return true;
  }
}
