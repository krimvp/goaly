/**
 * Heuristically derive the external programs a set of shell commands invokes — the toolchain/runners
 * that must already exist on PATH (e.g. `cargo`, `python`, `pytest`, `npm`, `go`). Used as the fallback
 * on the `--verify-cmd` path (no LLM to author a manifest) and as a belt-and-braces source under
 * `--generate`. Best-effort and deterministic: it splits each command on shell operators, drops leading
 * `VAR=value` assignments, takes the first bare token of each segment, and keeps only plausible program
 * names that aren't universally-present shell builtins/coreutils.
 *
 * It deliberately under-reports rather than over-reports: anything behind a subshell, `$(...)`, `xargs`,
 * or a pipe-into is skipped (its leading token isn't a plausible program name, or it's a builtin). The
 * authored manifest is the primary source; this just catches the obvious cases the LLM path doesn't.
 */

/** A program-name shape: letters, digits, and the few punctuation chars real binaries use. */
const PROGRAM_NAME = /^[A-Za-z][A-Za-z0-9._+-]*$/;

/**
 * Whether a tool name is safe to interpolate into the shell probe (`command -v <tool>`). Restricting to
 * this character set means the name carries no shell metacharacters — no quoting needed and no injection
 * possible from an LLM-authored manifest. A name that fails this simply isn't probed (we can't check it
 * safely, so we don't flag it missing).
 */
export function isProbeSafe(tool: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(tool);
}

/** A leading `FOO=bar` / `FOO=` env assignment to skip before the program token. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Universally-present shell builtins / coreutils not worth probing (a `command -v` would always find
 * them, so listing them only clutters the frozen manifest). Kept deliberately small — the probe itself
 * is the real filter, so a stray entry here is cosmetic, not correctness.
 */
const UBIQUITOUS = new Set([
  'sh', 'bash', 'zsh', 'env', 'cd', 'echo', 'printf', 'true', 'false', 'test', 'set', 'unset',
  'export', 'source', 'exit', 'return', 'read', 'pwd', 'cat', 'ls', 'cp', 'mv', 'rm', 'mkdir',
  'rmdir', 'touch', 'then', 'fi', 'do', 'done', 'else', 'elif', 'while', 'for', 'if', 'time',
  'sleep', 'wait', 'kill', 'trap', 'eval', 'exec', 'local', 'declare',
]);

/** Split a command line into segments on the shell control operators that start a new command. */
function segments(command: string): string[] {
  return command.split(/&&|\|\||[;\n|]/);
}

/** The leading program token of one segment, or null when it isn't a plain program invocation. */
function leadingProgram(segment: string): string | null {
  const tokens = segment.trim().split(/\s+/).filter((t) => t.length > 0);
  let i = 0;
  while (i < tokens.length && ENV_ASSIGNMENT.test(tokens[i]!)) i += 1; // skip `FOO=bar` prefixes
  const tok = tokens[i];
  if (tok === undefined) return null;
  // Strip surrounding quotes a command string may carry, then validate the shape.
  const name = tok.replace(/^['"]|['"]$/g, '');
  if (!PROGRAM_NAME.test(name)) return null; // (, $(, ./script, /abs/path, $VAR, etc. — skip
  if (UBIQUITOUS.has(name)) return null;
  return name;
}

/**
 * The distinct external programs referenced across `commands`, in first-seen order. Pure; safe to fold
 * into the frozen contract. Returns `[]` when nothing plausible is found (the common tool-less case).
 */
export function extractRequiredTools(commands: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const command of commands) {
    for (const segment of segments(command)) {
      const program = leadingProgram(segment);
      if (program !== null && !seen.has(program)) {
        seen.add(program);
        out.push(program);
      }
    }
  }
  return out;
}
