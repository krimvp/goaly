import type { RunConfig } from '../domain/config';
import type { ParsedArgs } from './args';

/**
 * `--dry-run`: resolve everything, run nothing.
 *
 * goaly's whole pitch is freezing the bar BEFORE spending anything, but until now the only way to
 * find out whether a `.goalyrc` parsed, which layer won a flag, or what the verifier intent actually
 * resolved to was to start a real run — minting a run directory and burning authoring tokens to read
 * back a config. This renders the fully-merged, fully-validated configuration instead.
 *
 * PURE (no IO, no clock, no process): it takes the already-parsed args and returns the text. The
 * caller decides where it goes, and a test can assert on it without a filesystem. It is rendered
 * AFTER every read-only validation the real run performs (config merge, `--baseline` resolution,
 * `--resume`/`--from-run` log reads, preflight) and BEFORE the first byte is written, so anything
 * that would have failed the run still fails the dry run with the same message and exit code.
 */
export function renderResolvedConfig(parsed: ParsedArgs, config: RunConfig): string {
  const sections: Section[] = [
    {
      title: 'Goal & contract',
      rows: [
        ['goal', config.goal],
        ['verifier', describeVerifier(config)],
        ...opt('smoke', config.smoke),
        ...opt('rubric', config.rubric),
        ['setup', describeSetup(config)],
        ['install-missing-tools', String(config.installMissingTools)],
        ...opt('verify-dir', parsed.verifyDir),
        ['autonomous (Seal)', String(config.autonomous)],
      ],
    },
    {
      title: 'Agents',
      rows: [
        ['harness', parsed.harness],
        ['harness-autonomy', parsed.harnessAutonomy ?? "(the CLI's own default)"],
        ['llm-provider', parsed.llmProvider],
        ...opt('base-url', parsed.baseUrl),
        ...modelRows(parsed),
      ],
    },
    {
      title: 'Loop',
      rows: [
        ['max-iterations', String(config.maxIterations)],
        ['candidates (best-of-N)', String(config.candidates)],
        ['phased', String(config.phased)],
        ...(config.phased
          ? ([
              ['max-phases', String(config.maxPhases)],
              ['parallel-phases', String(config.parallelPhases)],
              ['max-plan-revisions', String(config.maxPlanRevisions)],
              ['max-plan-retries', String(config.maxPlanRetries)],
              ...opt('plan-file', parsed.planFile),
            ] as Row[])
          : []),
        ['max-seal-revisions', String(config.maxSealRevisions)],
        ['max-compile-retries', String(config.maxCompileRetries)],
        ['adversarial', describeAdversarial(config)],
      ],
    },
    {
      title: 'Verification & review',
      rows: [
        ['judge quorum / floor', `${config.judge.quorum} / ${config.judge.confidenceFloor}`],
        ['approver quorum', String(config.approver.quorum)],
        ...opt('approver lenses', config.approver.lenses?.join(', ')),
        ['baseline', parsed.baseline ?? 'HEAD'],
        ['delta-verify', String(config.deltaVerify)],
      ],
    },
    {
      title: 'Budgets & timeouts',
      rows: [
        ['budget-tokens', config.budget.tokens === undefined ? 'unlimited' : String(config.budget.tokens)],
        [
          'budget-wall-ms',
          config.budget.wallClockMs === undefined ? 'unlimited' : String(config.budget.wallClockMs),
        ],
        ...timeoutRows(parsed),
      ],
    },
    {
      title: 'Stuck detection',
      rows: [
        ['no-diff', String(config.stuckPolicy.noDiff)],
        ['oscillation', String(config.stuckPolicy.oscillation)],
        ['repeat-failure threshold', String(config.stuckPolicy.repeatFailureThreshold)],
        ['crash threshold', String(config.stuckPolicy.harnessCrashThreshold)],
        ['unevaluable threshold', String(config.stuckPolicy.unevaluableThreshold)],
        ['diff-ignore', config.diffIgnore.length > 0 ? config.diffIgnore.join(', ') : '(defaults only)'],
      ],
    },
    {
      title: 'Environment',
      rows: [
        ['workspace', parsed.workspace],
        ...opt('worktree', typeof parsed.worktreeRun === 'string' ? parsed.worktreeRun : undefined),
        ['sandbox', parsed.sandbox.mode],
        ['log-level', parsed.logLevel],
        [
          'config files',
          parsed.configSources.length > 0 ? parsed.configSources.join(' < ') : '(none)',
        ],
        ...opt('resume', parsed.resumeRunId),
        ...opt('from-run', parsed.fromRunId),
      ],
    },
  ];

  const body = sections.map(renderSection).join('');
  const warnings =
    parsed.warnings.length > 0 ? `\n${parsed.warnings.map((w) => `  ! ${w}`).join('\n')}\n` : '';
  return (
    `\n── goaly --dry-run ──\n` +
    `nothing was run: no run directory, no lock, no tokens spent.\n` +
    `${warnings}${body}\n`
  );
}

type Row = readonly [string, string];
type Section = { readonly title: string; readonly rows: readonly Row[] };

/** A row that disappears entirely when its value is absent (keeps the output free of "undefined"). */
function opt(label: string, value: string | undefined): Row[] {
  return value === undefined ? [] : [[label, value]];
}

function renderSection(section: Section): string {
  if (section.rows.length === 0) return '';
  const width = Math.max(...section.rows.map(([label]) => label.length));
  const lines = section.rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`);
  return `\n${section.title}\n${lines.join('\n')}\n`;
}

/** The resolved verifier INTENT — the single most valuable thing to see before committing to a run. */
function describeVerifier(config: RunConfig): string {
  return config.verifier.kind === 'existing'
    ? `existing command: ${config.verifier.ref}`
    : `generate${config.verifier.intent !== undefined ? ` (intent: ${config.verifier.intent})` : ''}`;
}

function describeSetup(config: RunConfig): string {
  if (config.noSetup) return 'disabled (--no-setup)';
  if (config.setupCmd !== undefined) return config.setupCmd;
  // Only the --generate path has a compiler that authors one; don't promise it otherwise.
  return config.verifier.kind === 'generate' ? '(authored by the compiler)' : '(none)';
}

function describeAdversarial(config: RunConfig): string {
  const a = config.adversarial;
  if (!a.enabled) return 'off';
  return `on (plan critics ${a.planCritics}, contract critics ${a.contractCritics}, refuters ${a.refuters})`;
}

function modelRows(parsed: ParsedArgs): Row[] {
  const m = parsed.models;
  return [
    ...opt('model', m.model),
    ...opt('llm-model', m.llmModel),
    ...opt('judge-model', m.judgeModel),
    ...opt('approver-model', m.approverModel),
    ...opt('approver-models', m.approverModels?.join(', ')),
    ...opt('compiler-model', m.compilerModel),
    ...opt('planner-model', m.plannerModel),
    ...opt('critic-model', m.criticModel),
    ...opt('explain-model', m.explainModel),
  ];
}

function timeoutRows(parsed: ParsedArgs): Row[] {
  const t = parsed.timeouts;
  return [
    ...opt('harness-timeout-ms', num(t.harnessMs)),
    ...opt('harness-idle-timeout-ms', num(t.harnessIdleMs)),
    ...opt('llm-timeout-ms', num(t.llmMs)),
    ...opt('verify-timeout-ms', num(t.verifyMs)),
    ...opt('setup-timeout-ms', num(t.setupMs)),
  ];
}

function num(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}
