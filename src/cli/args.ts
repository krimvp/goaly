import { CliInput, cliInputToRunConfig, type RunConfig } from '../domain/config';

export type HarnessChoice = 'claude-code' | 'codex' | 'droid' | 'fake';

export type ParsedArgs = {
  command: 'run' | 'help';
  config: RunConfig;
  harness: HarnessChoice;
  workspace: string;
  resumeRunId: string | undefined;
};

export const USAGE = `goaly — run a coding agent until a frozen success contract is met.

Usage:
  goaly run --goal "<goal>" [--verify-cmd "<cmd>" | --generate [--intent "<hint>"]]
               [--rubric "<rubric>"] [--autonomous] [--max-iterations N]
               [--budget-tokens N] [--budget-wall-ms N]
               [--harness claude-code|codex|droid] [--workspace <dir>] [--resume <runId>]

  goaly help

Verification:
  --verify-cmd   point at an existing command that must exit 0
  --generate     have the agent author the verification (optionally guided by --intent)

Gate A (contract approval):
  default        a human approves the frozen contract once before the loop
  --autonomous   auto-accept the contract (still frozen; logged loudly)`;

type RawFlags = Record<string, string | boolean>;

function parseFlags(tokens: string[]): RawFlags {
  const flags: RawFlags = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.startsWith('--')) throw new UsageError(`unexpected argument: ${tok}`);
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = tokens[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[body] = true; // boolean flag
    } else {
      flags[body] = next;
      i++;
    }
  }
  return flags;
}

export class UsageError extends Error {}

function str(flags: RawFlags, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') throw new UsageError(`--${key} expects a value`);
  return v;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return helpResult();
  }
  if (command !== 'run') {
    throw new UsageError(`unknown command: ${command}`);
  }

  const flags = parseFlags(rest);

  const cliInput = CliInput.parse({
    goal: str(flags, 'goal'),
    ...(str(flags, 'verify-cmd') !== undefined ? { verifyCmd: str(flags, 'verify-cmd') } : {}),
    ...(flags['generate'] !== undefined ? { generate: true } : {}),
    ...(str(flags, 'intent') !== undefined ? { intent: str(flags, 'intent') } : {}),
    ...(str(flags, 'rubric') !== undefined ? { rubric: str(flags, 'rubric') } : {}),
    ...(flags['autonomous'] !== undefined ? { autonomous: true } : {}),
    ...(str(flags, 'max-iterations') !== undefined
      ? { maxIterations: str(flags, 'max-iterations') }
      : {}),
    ...(str(flags, 'budget-tokens') !== undefined
      ? { budgetTokens: str(flags, 'budget-tokens') }
      : {}),
    ...(str(flags, 'budget-wall-ms') !== undefined
      ? { budgetWallClockMs: str(flags, 'budget-wall-ms') }
      : {}),
  });

  const harness = parseHarness(str(flags, 'harness'));

  return {
    command: 'run',
    config: cliInputToRunConfig(cliInput),
    harness,
    workspace: str(flags, 'workspace') ?? process.cwd(),
    resumeRunId: str(flags, 'resume'),
  };
}

function parseHarness(value: string | undefined): HarnessChoice {
  if (value === undefined) return 'claude-code';
  if (value === 'claude-code' || value === 'codex' || value === 'droid' || value === 'fake') {
    return value;
  }
  throw new UsageError(`unknown harness: ${value} (expected claude-code | codex | droid | fake)`);
}

function helpResult(): ParsedArgs {
  return {
    command: 'help',
    // a placeholder config; never used for the help command.
    config: cliInputToRunConfig(CliInput.parse({ goal: 'help', verifyCmd: 'true' })),
    harness: 'claude-code',
    workspace: process.cwd(),
    resumeRunId: undefined,
  };
}
