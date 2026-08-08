import { USAGE } from './usage';
import { UsageError } from './flags/tokens';

/**
 * `goaly completion <shell>` (improvement plan 3.3): print a bash / zsh / fish completion script
 * to stdout. The flag list is EXTRACTED FROM `USAGE` — the same user-facing flag contract the
 * config drift test and docs-sync check read — so a new documented flag becomes completable with
 * no extra registration, and an undocumented flag cannot be completed at all.
 *
 * Install (one line, also in the README):
 *   bash:  source <(goaly completion bash)
 *   zsh:   source <(goaly completion zsh)
 *   fish:  goaly completion fish | source
 */

export type CompletionShell = 'bash' | 'zsh' | 'fish';

export type CompletionCommand = { readonly shell: CompletionShell };

/** The first-word subcommands (kept in sync by the completion test against `parseArgs`). */
export const SUBCOMMANDS: readonly string[] = [
  'run',
  'runs',
  'worktree',
  'ui',
  'doctor',
  'init',
  'config',
  'completion',
  'help',
];

/**
 * Flag-shaped tokens in `USAGE` that are NOT goaly flags: another tool's flags and prose globs,
 * mirroring the drift test's enumeration (subcommand flags like `--port` stay — they complete).
 */
const NOT_A_FLAG = new Set(['auto', 'rm', 'json', 'stuck-', 'baseline-style']);

/** Every completable `--flag`, extracted from the documented contract, deduped and sorted. */
export function documentedFlags(): string[] {
  const names = new Set(
    [...USAGE.matchAll(/--([a-z][a-z0-9-]*)/g)]
      .map((m) => m[1] as string)
      .filter((f) => !NOT_A_FLAG.has(f)),
  );
  return [...names].sort().map((f) => `--${f}`);
}

function bashScript(flags: string[]): string {
  return `# goaly bash completion — install with: source <(goaly completion bash)
_goaly_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local subcommands="${SUBCOMMANDS.join(' ')}"
  local flags="${flags.join(' ')}"
  if [[ \$COMP_CWORD -eq 1 && \$cur != -* ]]; then
    COMPREPLY=( \$(compgen -W "\$subcommands" -- "\$cur") )
  else
    COMPREPLY=( \$(compgen -W "\$flags" -- "\$cur") )
  fi
}
complete -F _goaly_completions goaly
`;
}

function zshScript(flags: string[]): string {
  return `# goaly zsh completion — install with: source <(goaly completion zsh)
_goaly() {
  local -a subcommands flags
  subcommands=(${SUBCOMMANDS.join(' ')})
  flags=(${flags.join(' ')})
  if (( CURRENT == 2 )) && [[ \$words[CURRENT] != -* ]]; then
    _describe 'goaly command' subcommands
  else
    compadd -- \$flags
  fi
}
if (( \$+functions[compdef] )); then
  compdef _goaly goaly
fi
`;
}

function fishScript(flags: string[]): string {
  const lines = [
    '# goaly fish completion — install with: goaly completion fish | source',
    'complete -c goaly -f',
    `complete -c goaly -n '__fish_use_subcommand' -a '${SUBCOMMANDS.join(' ')}'`,
    ...flags.map((f) => `complete -c goaly -l ${f.slice(2)}`),
  ];
  return `${lines.join('\n')}\n`;
}

/** Render the completion script for `shell`. Pure; the flag list comes from {@link documentedFlags}. */
export function renderCompletion(shell: CompletionShell): string {
  const flags = documentedFlags();
  if (shell === 'bash') return bashScript(flags);
  if (shell === 'zsh') return zshScript(flags);
  return fishScript(flags);
}

/** Validate the `<shell>` positional, fail-closed (invariant #6). */
export function parseCompletionShell(value: string | undefined): CompletionShell {
  if (value === 'bash' || value === 'zsh' || value === 'fish') return value;
  throw new UsageError(
    `completion requires a shell: goaly completion bash|zsh|fish (got '${value ?? '(none)'}')`,
  );
}
