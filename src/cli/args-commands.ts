import { CliInput, cliInputToRunConfig } from '../domain/config';
import { SandboxPolicy } from '../sandbox/policy';
import { ModelSelection } from './models';
import type { WorktreeCommand } from './worktree-cmd';
import type { DoctorCommand } from './doctor';
import type { InitCommand } from './init';
import {
  parseConfigCommand,
  parseDoctorCommand,
  parseInitCommand,
  parseRunsCommand,
  parseUiCommand,
  parseWorktreeCommand,
  type RunsCommand,
  type UiCommand,
} from './flags/subcommands';
import type { ConfigCommand } from './config-cmd';
import { parseCompletionShell } from './completion';
import type { ParsedArgs } from './args-types';

/**
 * The non-`run` command dispatch: maps a leading subcommand token (`help`, `runs`, `doctor`, …) onto
 * its parser and wraps the result in the shared {@link ParsedArgs} scaffold. `parseArgs` calls
 * {@link parseSubcommand} first and falls through to the run pipeline when it returns `undefined`.
 */

/** Parse a non-`run` command, or return `undefined` when `command` does not name one. */
export function parseSubcommand(
  command: string | undefined,
  rest: string[],
): ParsedArgs | undefined {
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return helpResult();
  }
  if (command === '--version' || command === '-v') {
    return versionResult();
  }
  if (command === 'runs') {
    return runsResult(parseRunsCommand(rest));
  }
  if (command === 'worktree') {
    return worktreeResult(parseWorktreeCommand(rest));
  }
  if (command === 'ui') {
    return uiResult(parseUiCommand(rest));
  }
  if (command === 'doctor') {
    return doctorResult(parseDoctorCommand(rest));
  }
  if (command === 'init') {
    return initResult(parseInitCommand(rest));
  }
  if (command === 'config') {
    return configResult(parseConfigCommand(rest));
  }
  if (command === 'completion') {
    return {
      ...baseArgs('completion', undefined, process.cwd()),
      completion: { shell: parseCompletionShell(rest[0]) },
    };
  }
  return undefined;
}

function helpResult(): ParsedArgs {
  return baseArgs('help', undefined, process.cwd());
}

function versionResult(): ParsedArgs {
  return baseArgs('version', undefined, process.cwd());
}

function runsResult(parsed: { runs: RunsCommand; workspace: string }): ParsedArgs {
  return baseArgs('runs', parsed.runs, parsed.workspace);
}

function worktreeResult(parsed: { worktree: WorktreeCommand; workspace: string }): ParsedArgs {
  return { ...baseArgs('worktree', undefined, parsed.workspace), worktree: parsed.worktree };
}

function uiResult(parsed: { ui: UiCommand; workspace: string }): ParsedArgs {
  return { ...baseArgs('ui', undefined, parsed.workspace), ui: parsed.ui };
}

function doctorResult(parsed: { doctor: DoctorCommand; workspace: string }): ParsedArgs {
  return { ...baseArgs('doctor', undefined, parsed.workspace), doctor: parsed.doctor };
}

function initResult(parsed: { init: InitCommand; workspace: string }): ParsedArgs {
  return { ...baseArgs('init', undefined, parsed.workspace), init: parsed.init };
}

function configResult(parsed: { config: ConfigCommand; workspace: string }): ParsedArgs {
  return { ...baseArgs('config', undefined, parsed.workspace), configCmd: parsed.config };
}

/**
 * The shared {@link ParsedArgs} scaffold for the non-`run` commands (help / runs). The run-specific
 * fields are placeholders never read for those commands — only `command`, `runs` and `workspace`
 * carry meaning.
 */
function baseArgs(
  command: ParsedArgs['command'],
  runs: RunsCommand | undefined,
  workspace: string,
): ParsedArgs {
  return {
    command,
    runs,
    worktree: undefined,
    ui: undefined,
    doctor: undefined,
    init: undefined,
    configCmd: undefined,
    completion: undefined,
    worktreeRun: undefined,
    // a placeholder config; never used for the help / runs commands.
    config: cliInputToRunConfig(CliInput.parse({ goal: 'help', verifyCmd: 'true' })),
    harness: 'claude',
    harnessExplicit: false,
    models: ModelSelection.parse({}),
    llmProvider: 'claude',
    llmProviderExplicit: false,
    harnessAutonomy: undefined,
    dryRun: false,
    workspace,
    workspaceMode: 'auto',
    baseline: undefined,
    verifyDir: undefined,
    defects: { enabled: true },
    planFile: undefined,
    resumeRunId: undefined,
    fromRunId: undefined,
    inheritSession: false,
    recontract: undefined,
    logLevel: 'info',
    logFile: undefined,
    noLogFile: false,
    stream: false,
    explain: false,
    streamTranscript: false,
    streamFile: undefined,
    timeouts: {},
    maxAgentTurns: undefined,
    sandbox: SandboxPolicy.parse({}),
    costTablePath: undefined,
    configSources: [],
    warnings: [],
    baseUrl: undefined,
    llmApiKeyEnv: 'OPENAI_API_KEY',
    resumeExtend: undefined,
    delegation: undefined,
  };
}
