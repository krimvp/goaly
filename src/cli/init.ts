import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { overlayFromConfig, IMPLICIT_CONFIG_FILENAME } from './config-file';
import { runDoctor, type DoctorProbes } from './doctor';
import { UsageError } from './flags/tokens';
import { isHarnessChoice, PUBLIC_HARNESS_CHOICES } from './flags/harness-flags';

/**
 * `goaly init` (Phase 2.2 of the improvement plan): write a starter `.goalyrc` so common wiring
 * (harness, autonomy, model, verify command) need not be retyped on every run. Values come from
 * flags when given; anything not covered by a flag is asked interactively on a TTY and defaulted
 * otherwise, so `goaly init --harness codex --autonomous` works headless in CI.
 *
 * The candidate config is round-tripped through the SAME fail-closed schema the run path parses
 * (`overlayFromConfig`) before a byte is written — `goaly init` structurally cannot write a config
 * that `goaly run` would reject. An existing `.goalyrc` is never clobbered without `--force`.
 * It runs `goaly doctor` first so the user fixes environment gaps before saving defaults.
 */

export type InitCommand = {
  readonly harness: string | undefined;
  readonly autonomous: boolean;
  readonly model: string | undefined;
  readonly verifyCmd: string | undefined;
  /** Overwrite an existing `.goalyrc`. */
  readonly force: boolean;
  /** Skip the interactive prompts even on a TTY (take flag/default values as-is). */
  readonly yes: boolean;
};

export type InitIo = {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Ask one question; resolves the raw answer ('' = accept default). Injectable for tests. */
  ask?: (question: string) => Promise<string>;
  /** Whether interactive prompts are possible (default: stdin AND stdout are TTYs). */
  interactive?: boolean;
  /** Injectable doctor probes, forwarded verbatim. */
  probes?: DoctorProbes;
};

function defaultAsk(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    }),
  );
}

/** Write `.goalyrc` in `workspace`; returns the process exit code. */
export async function runInit(cmd: InitCommand, workspace: string, io: InitIo): Promise<number> {
  const target = path.join(workspace, IMPLICIT_CONFIG_FILENAME);

  // Refuse to clobber silently — an existing config is someone's working setup.
  const existing = await readFile(target, 'utf8').then(
    (t) => t,
    () => undefined,
  );
  if (existing !== undefined && !cmd.force) {
    io.err(`goaly init: ${target} already exists — re-run with --force to overwrite it\n`);
    return 2;
  }

  // Doctor first: fix the environment before saving defaults that assume it.
  await runDoctor({ baseUrl: undefined }, workspace, io.out, io.probes ?? {});
  io.out('\n');

  const interactive = io.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const ask = io.ask ?? defaultAsk;
  const askFor = async (label: string, flagValue: string | undefined, def: string): Promise<string> => {
    if (flagValue !== undefined) return flagValue;
    if (!interactive || cmd.yes) return def;
    const answer = await ask(`${label} [${def === '' ? 'none' : def}]: `);
    return answer === '' ? def : answer;
  };

  const harness = await askFor(
    `default harness (${PUBLIC_HARNESS_CHOICES.join(' | ')})`,
    cmd.harness,
    'claude',
  );
  if (!isHarnessChoice(harness)) {
    io.err(
      `goaly init: unknown harness '${harness}' (expected ${PUBLIC_HARNESS_CHOICES.join(' | ')})\n`,
    );
    return 2;
  }
  const autonomousAnswer = cmd.autonomous
    ? 'y'
    : !interactive || cmd.yes
      ? 'n'
      : await ask('autonomous by default — auto-accept the frozen contract? (y/N): ');
  const autonomous = /^y(es)?$/i.test(autonomousAnswer.trim());
  const model = await askFor('default model (empty = harness default)', cmd.model, '');
  const verifyCmd = await askFor(
    'default verify command (empty = choose per run)',
    cmd.verifyCmd,
    '',
  );

  const config: Record<string, string | boolean> = {
    harness,
    ...(autonomous ? { autonomous: true } : {}),
    ...(model !== '' ? { model } : {}),
    ...(verifyCmd !== '' ? { 'verify-cmd': verifyCmd } : {}),
  };

  // Round-trip through the run path's fail-closed schema BEFORE writing (invariant #6): if this
  // throws, nothing lands on disk and the user sees the same message a run would produce.
  try {
    overlayFromConfig(config, IMPLICIT_CONFIG_FILENAME);
  } catch (e) {
    io.err(`goaly init: refusing to write an invalid config: ${e instanceof UsageError ? e.message : String(e)}\n`);
    return 2;
  }

  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  io.out(`wrote ${target}\n`);
  io.out(
    `\nNext: goaly "your goal"${config['verify-cmd'] !== undefined ? '' : ' --verify-cmd "npm test"'}` +
      ` — flags you type always override ${IMPLICIT_CONFIG_FILENAME}.\n`,
  );
  return 0;
}
