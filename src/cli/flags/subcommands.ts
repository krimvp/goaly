import { z } from 'zod';
import { WorktreeName } from '../../workspace/worktree-manager';
import type { WorktreeCommand } from '../worktree-cmd';
import type { DoctorCommand } from '../doctor';
import type { InitCommand } from '../init';
import type { ConfigCommand } from '../config-cmd';
import { UsageError, parseFlags, str, type RawFlags } from './tokens';

/**
 * The read-only run-inspection subcommand (`goaly runs list` / `goaly runs show <id>` /
 * `goaly runs resume-cmd <id>`). `resume-cmd` (Capability A) prints how to continue the run's
 * underlying CLI session; `harness` is an optional fallback for a log written before the header
 * recorded the harness identity.
 */
export type RunsCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'show'; readonly runId: string }
  | { readonly kind: 'resume-cmd'; readonly runId: string; readonly harness: string | undefined }
  | { readonly kind: 'watch'; readonly runId: string };

/** The `goaly ui` subcommand: the local web UI server (ADR 0014). */
export type UiCommand = {
  /** Port to listen on (default 4180). */
  readonly port: number | undefined;
};

/**
 * Parse the read-only `runs` subcommand. `<runId>` is a positional (not a `--flag`); only
 * `--workspace` is honoured (it locates the `.goaly` run-log directory). Fails closed on a
 * missing/unknown subcommand or a missing run id.
 */
export function parseRunsCommand(rest: string[]): { runs: RunsCommand; workspace: string } {
  const [sub, ...subRest] = rest;
  if (sub === 'list') {
    return { runs: { kind: 'list' }, workspace: runsWorkspace(subRest) };
  }
  if (sub === 'show') {
    const runId = subRest[0];
    if (runId === undefined || runId.startsWith('--')) {
      throw new UsageError('runs show requires a <runId> (e.g. goaly runs show run-1234)');
    }
    return { runs: { kind: 'show', runId }, workspace: runsWorkspace(subRest.slice(1)) };
  }
  if (sub === 'resume-cmd') {
    const runId = subRest[0];
    if (runId === undefined || runId.startsWith('--')) {
      throw new UsageError('runs resume-cmd requires a <runId> (e.g. goaly runs resume-cmd run-1234)');
    }
    const flags = parseFlags(subRest.slice(1)).flags;
    return {
      runs: { kind: 'resume-cmd', runId, harness: str(flags, 'harness') },
      workspace: str(flags, 'workspace') ?? process.cwd(),
    };
  }
  if (sub === 'watch') {
    const runId = subRest[0];
    if (runId === undefined || runId.startsWith('--')) {
      throw new UsageError('runs watch requires a <runId> (e.g. goaly runs watch run-1234)');
    }
    return { runs: { kind: 'watch', runId }, workspace: runsWorkspace(subRest.slice(1)) };
  }
  throw new UsageError(
    `unknown runs subcommand: ${sub ?? '(none)'} (expected list | show | resume-cmd | watch)`,
  );
}

function runsWorkspace(tokens: string[]): string {
  return str(parseFlags(tokens).flags, 'workspace') ?? process.cwd();
}

/**
 * Validate the `--worktree [<name>]` run flag at the seam: a bare flag (`true`) means auto-name;
 * a string must be a valid {@link WorktreeName} — fail-closed on anything else (invariant #6).
 */
export function parseWorktreeRun(flags: RawFlags): string | true | undefined {
  const v = flags['worktree'];
  if (v === undefined) return undefined;
  if (v === true) return true;
  const parsed = WorktreeName.safeParse(v);
  if (!parsed.success) {
    throw new UsageError(`--worktree: ${parsed.error.issues[0]?.message ?? 'invalid worktree name'}`);
  }
  return parsed.data;
}

/**
 * Parse the `goaly worktree` subcommand (create / list / remove). `<name>` is a positional,
 * validated at this seam with the same fail-closed {@link WorktreeName} schema the manager uses.
 */
export function parseWorktreeCommand(rest: string[]): { worktree: WorktreeCommand; workspace: string } {
  const [sub, ...subRest] = rest;
  if (sub === 'list') {
    return { worktree: { kind: 'list' }, workspace: runsWorkspace(subRest) };
  }
  if (sub === 'create') {
    const name = worktreeNamePositional(subRest, 'create');
    const flags = parseFlags(subRest.slice(1)).flags;
    return {
      worktree: { kind: 'create', name, base: str(flags, 'base') },
      workspace: str(flags, 'workspace') ?? process.cwd(),
    };
  }
  if (sub === 'remove') {
    const name = worktreeNamePositional(subRest, 'remove');
    const flags = parseFlags(subRest.slice(1)).flags;
    return {
      worktree: {
        kind: 'remove',
        name,
        force: flags['force'] !== undefined,
        deleteBranch: flags['delete-branch'] !== undefined,
      },
      workspace: str(flags, 'workspace') ?? process.cwd(),
    };
  }
  throw new UsageError(
    `unknown worktree subcommand: ${sub ?? '(none)'} (expected create | list | remove)`,
  );
}

function worktreeNamePositional(subRest: string[], sub: string): string {
  const raw = subRest[0];
  if (raw === undefined || raw.startsWith('-')) {
    throw new UsageError(`worktree ${sub} requires a <name> (e.g. goaly worktree ${sub} feature-x)`);
  }
  const parsed = WorktreeName.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `worktree ${sub} '${raw}': ${parsed.error.issues[0]?.message ?? 'invalid worktree name'}`,
    );
  }
  return parsed.data;
}

/** Parse `goaly doctor [--base-url <url>] [--workspace <dir>]`. */
export function parseDoctorCommand(rest: string[]): { doctor: DoctorCommand; workspace: string } {
  const flags = parseFlags(rest).flags;
  return {
    doctor: { baseUrl: str(flags, 'base-url') },
    workspace: str(flags, 'workspace') ?? process.cwd(),
  };
}

/**
 * Parse `goaly init [--harness <n>] [--autonomous] [--model <m>] [--verify-cmd "<c>"] [--yes]
 * [--force] [--workspace <dir>]`. Value validation (e.g. an unknown harness) happens in `runInit`
 * so the interactive path answers with the same message.
 */
export function parseInitCommand(rest: string[]): { init: InitCommand; workspace: string } {
  const flags = parseFlags(rest).flags;
  return {
    init: {
      harness: str(flags, 'harness'),
      autonomous: flags['autonomous'] !== undefined,
      model: str(flags, 'model'),
      verifyCmd: str(flags, 'verify-cmd'),
      force: flags['force'] !== undefined,
      yes: flags['yes'] !== undefined,
    },
    workspace: str(flags, 'workspace') ?? process.cwd(),
  };
}

/**
 * Parse `goaly config validate <path>` / `goaly config presets [--names]` — fail-closed on a
 * missing/unknown subcommand or path.
 */
export function parseConfigCommand(rest: string[]): { config: ConfigCommand; workspace: string } {
  const [sub, ...subRest] = rest;
  if (sub === 'validate') {
    const path = subRest[0];
    if (path === undefined || path.startsWith('-')) {
      throw new UsageError(
        'config validate requires a <path> (e.g. goaly config validate .goalyrc)',
      );
    }
    return {
      config: { kind: 'validate', path },
      workspace: str(parseFlags(subRest.slice(1)).flags, 'workspace') ?? process.cwd(),
    };
  }
  if (sub === 'presets') {
    const flags = parseFlags(subRest).flags;
    return {
      config: { kind: 'presets', names: flags['names'] !== undefined },
      workspace: str(flags, 'workspace') ?? process.cwd(),
    };
  }
  if (sub === 'defects') {
    // The cross-run defect corpus (issue #122): inspect or reset it. `--defect-corpus <path>` picks
    // a non-default corpus, exactly as on a run. Fails closed on an unknown action.
    const [action, ...actionRest] = subRest;
    if (action !== 'list' && action !== 'clear') {
      throw new UsageError(
        `unknown config defects action: ${action ?? '(none)'} (expected list | clear)`,
      );
    }
    const flags = parseFlags(actionRest).flags;
    const corpusPath = str(flags, 'defect-corpus');
    return {
      config: { kind: 'defects', action, ...(corpusPath !== undefined ? { path: corpusPath } : {}) },
      workspace: str(flags, 'workspace') ?? process.cwd(),
    };
  }
  throw new UsageError(
    `unknown config subcommand: ${sub ?? '(none)'} (expected validate | presets | defects)`,
  );
}

/** Parse `goaly ui [--port N] [--workspace <dir>]`, each validated fail-closed at the seam. */
export function parseUiCommand(rest: string[]): { ui: UiCommand; workspace: string } {
  const flags = parseFlags(rest).flags;
  const rawPort = str(flags, 'port');
  let port: number | undefined;
  if (rawPort !== undefined) {
    const parsed = z.coerce.number().int().min(1).max(65535).safeParse(rawPort);
    if (!parsed.success) {
      throw new UsageError(`--port: expected an integer in 1..65535, got '${rawPort}'`);
    }
    port = parsed.data;
  }
  return {
    ui: { port },
    workspace: str(flags, 'workspace') ?? process.cwd(),
  };
}
