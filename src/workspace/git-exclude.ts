import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The result of trying to register a path in `.git/info/exclude` (issue #52). Best-effort: it NEVER
 * throws — a failure (no `.git` dir, read-only fs, a `.git` file from a worktree/submodule) degrades
 * to `{ ok: false }` so the caller can log it and carry on. "Excluded ≠ unprotected": the integrity
 * guard pins generated files by content hash on disk, independent of git tracking.
 */
export type ExcludeResult =
  | { ok: true; /** false ⇒ the entry was already present (idempotent no-op). */ excluded: boolean }
  | { ok: false; reason: string };

/**
 * Append-once registration of a workspace-relative path in `.git/info/exclude` — git's per-clone,
 * never-committed ignore list. Lets goaly author verification files into idiomatic locations (so a
 * test framework's auto-discovery still finds them) WITHOUT polluting the user's `git status` or
 * touching any TRACKED file. Idempotent (a path already present is not re-appended) and fail-closed in
 * the hygiene sense (any error is returned, never thrown).
 */
export async function excludeFromGit(
  workspaceRoot: string,
  relPath: string,
): Promise<ExcludeResult> {
  try {
    const excludeFile = path.join(workspaceRoot, '.git', 'info', 'exclude');
    const entry = normalizeEntry(relPath);
    let existing = '';
    try {
      existing = await readFile(excludeFile, 'utf8');
    } catch {
      // No exclude file yet — make sure `.git/info` exists so the append below can create it.
      await mkdir(path.dirname(excludeFile), { recursive: true });
    }
    if (hasEntry(existing, entry)) return { ok: true, excluded: false };
    // Keep the file newline-terminated so a pre-existing no-trailing-newline file stays well-formed.
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await appendFile(excludeFile, `${prefix}${entry}\n`, 'utf8');
    return { ok: true, excluded: true };
  } catch (e: unknown) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Anchor the entry to the repo root with a leading slash (git exclude syntax) so it matches exactly
 * this path, never a same-named file in some subdirectory. Normalizes to POSIX separators and strips
 * any leading `./` or `/`.
 */
function normalizeEntry(relPath: string): string {
  const posix = relPath.split(path.sep).join('/').replace(/^\.?\/*/, '');
  return `/${posix}`;
}

function hasEntry(content: string, entry: string): boolean {
  return content.split('\n').some((line) => line.trim() === entry);
}
