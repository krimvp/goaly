import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../log/logger';
import { excludeFromGit } from './git-exclude';

/**
 * The ONE path-traversal boundary for workspace-relative file IO, shared by every consumer that
 * touches files a contract names: the compiler's authored-file writes, the Driver's refreeze
 * re-reads (`GitWorkspace.readFile`), and the goaly-ui review station's gate-file routes
 * (ADR 0016). Paths inside a contract are untrusted at every seam — one guard, zero drift.
 */

/** Resolve `rel` under `root`, or null when it escapes the root (fail-closed). */
export function resolveUnderRoot(root: string, rel: string): string | null {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, rel);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

/**
 * Write a workspace-relative file, refusing any path that escapes the workspace root (compiler
 * output and operator edits are untrusted — this is a path-traversal boundary).
 */
export async function writeWorkspaceFile(root: string, rel: string, content: string): Promise<void> {
  const resolved = resolveUnderRoot(root, rel);
  if (resolved === null) {
    throw new Error(`refusing to write outside the workspace: ${rel}`);
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf8');
}

/**
 * UTF-8 content of a workspace-relative file, or `null` when it is absent, unreadable, or escapes
 * the workspace root — fail-closed, mirroring `Workspace.fileHash` (a pinned path is untrusted).
 */
export async function readWorkspaceFile(root: string, rel: string): Promise<string | null> {
  const resolved = resolveUnderRoot(root, rel);
  if (resolved === null) return null;
  try {
    return await readFile(resolved, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Write a compiler-authored (or operator-edited) verification file and seamlessly keep it out of
 * the user's git (issue #52): after the path-guarded write, register the exact path in
 * `.git/info/exclude` so it never shows up in `git status` and is never accidentally committed —
 * no `.gitignore` edit, no tracked file touched, nothing for the user to review or undo. The
 * exclude step is best-effort and fail-closed: a failure degrades to "not excluded" (logged
 * loudly), never a changed run outcome. One loud log line per file tells the user what was
 * authored and how to keep it (`git add -f`).
 */
export async function writeVerificationFile(
  root: string,
  rel: string,
  content: string,
  logger: Logger,
): Promise<void> {
  await writeWorkspaceFile(root, rel, content);
  const result = await excludeFromGit(root, rel);
  if (result.ok) {
    logger.info('authored verification file', {
      path: rel,
      excludedLocally: result.excluded,
      keep: 'git add -f to keep it as durable verification',
    });
  } else {
    logger.warn('authored verification file (could not exclude from git — it may show in git status)', {
      path: rel,
      reason: result.reason,
    });
  }
}
