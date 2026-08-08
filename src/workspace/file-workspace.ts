import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { DiffHash } from '../domain/ids';
import { sha256Hex } from '../util/hash';
import { realExec, type ExecFn } from './git-workspace';
import type { CommandResult, Workspace } from './workspace';

/**
 * A file-system-backed {@link Workspace} that does not require git. It maintains a
 * content-addressed manifest of tracked files and stores baseline manifests under
 * `.goaly/baselines/` so diffing, checkpointing, and resume work without git plumbing.
 *
 * This is the non-git implementation behind the `Workspace` seam (ADR 0018). The
 * orchestrator and driver cannot tell whether they are talking to `GitWorkspace` or
 * `FileWorkspace`.
 */

/** Conventional `timeout(1)` exit code; surfaced when we kill a command for exceeding `timeoutMs`. */
const TIMEOUT_EXIT_CODE = 124;

/** Manifest entry: the sha256 of a file's UTF-8 content. */
type Manifest = ReadonlyMap<string, string>;

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

/** Hash a manifest deterministically (sorted paths, sha256 content hashes). */
function hashManifest(manifest: Manifest): string {
  const entries = [...manifest.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256Hex(entries.map(([p, h]) => `${p}:${h}`).join('\n'));
}

/** Serialize a manifest to a deterministic JSON string. */
function manifestToJson(manifest: Manifest): string {
  const obj: Record<string, string> = {};
  for (const [p, h] of [...manifest.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    obj[p] = h;
  }
  return JSON.stringify(obj, null, 2);
}

/** Parse a manifest from JSON. */
function manifestFromJson(text: string): Manifest {
  const parsed = JSON.parse(text) as Record<string, string>;
  return new Map(Object.entries(parsed));
}

/** Empty manifest hash — the default baseline for a tree with no prior snapshot. */
const EMPTY_MANIFEST_HASH = hashManifest(new Map());

async function walk(root: string, excludes: readonly string[]): Promise<Manifest> {
  const manifest = new Map<string, string>();
  const excludeSet = new Set(excludes.map(normalizeRel));

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = normalizeRel(relative(root, full));
      if (excludeSet.has(rel) || rel.startsWith('.goaly/') || rel === '.goaly') {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        try {
          const content = await readFile(full, 'utf-8');
          manifest.set(rel, sha256Hex(content));
        } catch {
          // Ignore unreadable files for the manifest; fileHash/readFile will fail-closed.
        }
      }
    }
  }

  try {
    await visit(root);
  } catch {
    // Directory may not exist yet.
  }
  return manifest;
}

async function readContent(root: string, relPath: string): Promise<string | null> {
  const full = resolve(root, relPath);
  if (!full.startsWith(resolve(root))) return null;
  try {
    return await readFile(full, 'utf-8');
  } catch {
    return null;
  }
}

/** Render a unified-diff-style textual diff between two manifests. */
async function renderDiff(root: string, prev: Manifest, next: Manifest): Promise<string> {
  const allPaths = new Set([...prev.keys(), ...next.keys()]);
  const sorted = [...allPaths].sort();
  const lines: string[] = [];
  for (const p of sorted) {
    const oldHash = prev.get(p);
    const newHash = next.get(p);
    if (oldHash === undefined) {
      const content = (await readContent(root, p)) ?? '';
      const contentLines = content.split('\n');
      lines.push(`--- /dev/null`, `+++ b/${p}`);
      lines.push(`@@ -0,0 +1,${contentLines.length} @@`);
      for (const cl of contentLines) lines.push(`+${cl}`);
    } else if (newHash === undefined) {
      lines.push(`--- a/${p}`, `+++ /dev/null`, `@@ -1 +0,0 @@`, `-  ${p}`);
    } else if (oldHash !== newHash) {
      const oldContent = (await readContent(root, p)) ?? '';
      const newContent = (await readContent(root, p)) ?? '';
      // Simple whole-file replacement diff; good enough for the judge/approver input.
      const oldLines = oldContent.split('\n');
      const newLines = newContent.split('\n');
      lines.push(`--- a/${p}`, `+++ b/${p}`);
      lines.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
      for (const cl of oldLines) lines.push(`-${cl}`);
      for (const cl of newLines) lines.push(`+${cl}`);
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
    try {
      const text = await readFile(this.#baselineFile(hash), 'utf-8');
      return manifestFromJson(text);
    } catch {
      return new Map();
    }
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
    const raw = await renderDiff(this.#root, base, next);

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
    const r = await this.#exec('sh', ['-c', command], {
      cwd: this.#root,
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return {
      exitCode: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      ...(r.timedOut ? { timedOut: true } : {}),
    };
  }

  async fileHash(relPath: string): Promise<string | null> {
    const normalized = normalizeRel(relPath);
    const full = resolve(this.#root, normalized);
    if (!full.startsWith(resolve(this.#root))) return null;
    try {
      const content = await readFile(full, 'utf-8');
      return sha256Hex(content);
    } catch {
      return null;
    }
  }

  async readFile(relPath: string): Promise<string | null> {
    const normalized = normalizeRel(relPath);
    const full = resolve(this.#root, normalized);
    if (!full.startsWith(resolve(this.#root))) return null;
    try {
      return await readFile(full, 'utf-8');
    } catch {
      return null;
    }
  }

  async isEmptyOfSource(generatedFiles: readonly string[]): Promise<boolean> {
    const m = await walk(this.#root, this.#excludes);
    const generatedSet = new Set(generatedFiles.map(normalizeRel));
    for (const p of m.keys()) {
      if (generatedSet.has(p) || isDocOrMeta(p)) continue;
      return false;
    }
    return true;
  }
}
