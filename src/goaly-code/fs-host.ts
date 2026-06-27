/**
 * The production {@link ToolHost}: path-guarded filesystem operations against the workspace root, plus
 * an INJECTED shell exec for `run_shell` (the only untrusted exec — the composition root hands in the
 * sandbox-wrapped exec; tests hand in a fake). File edits go through goaly's own writers here, NOT a
 * subprocess, which is the goaly-code harness's finer-grained isolation (spec §2.5): the untrusted surface
 * shrinks to `run_shell`.
 *
 * Every path is resolved under the root and any escape is refused (the same traversal boundary as
 * `GitWorkspace.fileHash` / the compiler's `writeWorkspaceFile`). All output is bounded so a giant
 * file or a chatty command can't blow up the model's context.
 */

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { applyEdit } from './edit';
import type { ToolHost } from './tools';

/** The injected, sandbox-wrapped shell. Returns the raw process result; the host formats it. */
export type ShellExec = (
  command: string,
) => Promise<{ stdout: string; stderr: string; code: number; timedOut?: boolean }>;

/** Cap a single file read so an enormous file can't flood the context. */
const MAX_READ_CHARS = 100_000;
/** Cap combined run_shell output. */
const MAX_SHELL_CHARS = 30_000;
/** Bounds for grep so a large tree stays cheap and the result fits the context. */
const GREP_MAX_MATCHES = 200;
const GREP_MAX_FILES = 5_000;
/** Directories never walked by grep (vcs/build/deps/state). */
const GREP_SKIP_DIRS = new Set(['.git', 'node_modules', '.goaly', 'dist', 'coverage', '.next', '.cache']);

/** Truncate `s` to `max` chars with a trailing marker when it overflows. */
function cap(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

export class NodeToolHost implements ToolHost {
  readonly #root: string;
  readonly #shell: ShellExec;

  constructor(opts: { root: string; shell: ShellExec }) {
    this.#root = path.resolve(opts.root);
    this.#shell = opts.shell;
  }

  /** Resolve a workspace-relative path under the root, refusing any escape (traversal boundary). */
  #resolve(rel: string): string {
    const resolved = path.resolve(this.#root, rel);
    if (resolved !== this.#root && !resolved.startsWith(this.#root + path.sep)) {
      throw new Error(`path escapes the workspace: ${rel}`);
    }
    return resolved;
  }

  async readFile(rel: string, range?: { startLine?: number; endLine?: number }): Promise<string> {
    const content = await readFile(this.#resolve(rel), 'utf8');
    if (range === undefined) return cap(content, MAX_READ_CHARS);
    const lines = content.split('\n');
    const start = Math.max(1, range.startLine ?? 1);
    const end = Math.min(lines.length, range.endLine ?? lines.length);
    if (start > lines.length) return `(file has ${lines.length} lines; start_line ${start} is past the end)`;
    return cap(lines.slice(start - 1, end).join('\n'), MAX_READ_CHARS);
  }

  async listDir(rel: string): Promise<string> {
    const entries = await readdir(this.#resolve(rel), { withFileTypes: true });
    if (entries.length === 0) return '(empty directory)';
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join('\n');
  }

  async grep(pattern: string, rel: string | undefined): Promise<string> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (e) {
      return `Error: invalid regular expression: ${e instanceof Error ? e.message : String(e)}`;
    }
    const base = this.#resolve(rel ?? '.');
    const matches: string[] = [];
    let filesScanned = 0;
    const stack: string[] = [base];
    while (stack.length > 0 && matches.length < GREP_MAX_MATCHES && filesScanned < GREP_MAX_FILES) {
      const dir = stack.pop()!;
      const info = await stat(dir).catch(() => null);
      if (info === null) continue;
      if (info.isFile()) {
        filesScanned += await this.#grepFile(dir, regex, matches);
        continue;
      }
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.isDirectory()) {
          if (!GREP_SKIP_DIRS.has(e.name)) stack.push(path.join(dir, e.name));
        } else if (e.isFile()) {
          filesScanned += await this.#grepFile(path.join(dir, e.name), regex, matches);
          if (matches.length >= GREP_MAX_MATCHES) break;
        }
      }
    }
    if (matches.length === 0) return '(no matches)';
    const header = matches.length >= GREP_MAX_MATCHES ? `(showing first ${GREP_MAX_MATCHES} matches)\n` : '';
    return header + matches.join('\n');
  }

  /** Match `regex` against each line of one file, appending "relpath:line: text" rows. Returns 1 (scanned). */
  async #grepFile(abs: string, regex: RegExp, out: string[]): Promise<number> {
    const content = await readFile(abs, 'utf8').catch(() => null);
    if (content === null) return 1; // unreadable/binary — counted as scanned, skipped
    const relPath = path.relative(this.#root, abs);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length && out.length < GREP_MAX_MATCHES; i++) {
      if (regex.test(lines[i]!)) out.push(`${relPath}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
    }
    return 1;
  }

  async writeFile(rel: string, content: string): Promise<string> {
    const abs = this.#resolve(rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
    return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${rel}`;
  }

  async editFile(rel: string, oldString: string, newString: string): Promise<string> {
    const abs = this.#resolve(rel);
    const content = await readFile(abs, 'utf8');
    const result = applyEdit(content, oldString, newString);
    if (!result.ok) return `edit_file failed: ${result.reason}`;
    await writeFile(abs, result.content, 'utf8');
    return `Edited ${rel} (${result.strategy} match)`;
  }

  async runShell(command: string): Promise<string> {
    const r = await this.#shell(command);
    const parts: string[] = [];
    if (r.timedOut === true) parts.push('[command timed out]');
    parts.push(`exit code: ${r.code}`);
    if (r.stdout.length > 0) parts.push(`stdout:\n${r.stdout}`);
    if (r.stderr.length > 0) parts.push(`stderr:\n${r.stderr}`);
    return cap(parts.join('\n'), MAX_SHELL_CHARS);
  }
}
