import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DriverDeps } from '../driver/driver';
import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { RunId, SessionId } from '../domain/ids';
import { SessionId as SessionIdSchema } from '../domain/ids';
import type { HarnessAdapter } from '../harness/adapter';
import type { HarnessRunResult } from '../domain/events';
import type { Verifier } from '../verify/verifier';
import type { LlmProvider } from '../llm/provider';
import { Ladder } from '../verify/ladder';
import { DeterministicVerifier } from '../verify/deterministic';
import { JudgeVerifier } from '../verify/judge';
import { AgentApprover } from '../verify/agent-approver';
import { AgentCompiler } from '../compile/agent-compiler';
import { AutoContractGate, HumanContractGate } from '../compile/gates';
import { GitWorkspace } from '../workspace/git-workspace';
import { FileRunLog } from '../runlog/file-runlog';
import { ClaudeCodeAdapter } from '../harness/claude-code';
import { CodexAdapter } from '../harness/codex';
import { SystemClock } from '../driver/clock';
import { SystemBudgetMeter } from '../driver/budget';
import { CliLlmProvider } from '../llm/cli-provider';
import type { HarnessChoice } from './args';

export type ComposeOptions = {
  harness: HarnessChoice;
  workspaceRoot: string;
  runId: RunId;
  /** Override the LLM provider (tests inject a FakeLlm; production uses the CLI provider). */
  llm?: LlmProvider;
  /** Where run logs live. Default `<workspaceRoot>/.goalorch` (excluded from diffHash). */
  stateDir?: string;
};

/** The orchestrator's own state directory name, kept out of stuck-detection hashing. */
export const STATE_DIR = '.goalorch';

/**
 * The composition root: assemble a fully-wired {@link DriverDeps} from validated config. This
 * is the only place that knows which concrete adapter/verifier/gate backs each seam, and the
 * only place that turns the frozen contract's rungs into a runnable Ladder.
 */
export function composeDeps(config: RunConfig, options: ComposeOptions): DriverDeps {
  const llm = options.llm ?? new CliLlmProvider();
  const clock = new SystemClock();
  const workspace = new GitWorkspace(options.workspaceRoot);
  const stateDir = options.stateDir ?? path.join(options.workspaceRoot, STATE_DIR);

  return {
    compiler: new AgentCompiler({
      llm,
      writeFile: (rel, content) => writeWorkspaceFile(options.workspaceRoot, rel, content),
    }),
    gateA: config.autonomous ? new AutoContractGate() : new HumanContractGate(),
    harness: makeHarness(options.harness),
    makeLadder: (contract) => buildLadder(contract, llm),
    approver: new AgentApprover({ llm }),
    workspace,
    clock,
    budget: new SystemBudgetMeter(config.budget, clock),
    runlog: new FileRunLog(path.join(stateDir, options.runId)),
  };
}

/** Turn the frozen contract's ordered rungs into a Ladder of concrete verifiers. */
export function buildLadder(contract: CompiledContract, llm: LlmProvider): Verifier {
  const rungs: Verifier[] = contract.rungs.map((rung) =>
    rung.kind === 'deterministic'
      ? new DeterministicVerifier(rung.command, rung.label)
      : new JudgeVerifier({
          rubric: rung.rubric,
          quorum: rung.quorum,
          confidenceFloor: rung.confidenceFloor,
          llm,
        }),
  );
  return new Ladder(rungs);
}

function makeHarness(choice: HarnessChoice): HarnessAdapter {
  switch (choice) {
    case 'claude-code':
      return new ClaudeCodeAdapter();
    case 'codex':
      return new CodexAdapter();
    case 'fake':
      return new NoopHarness();
  }
}

/**
 * A harness that makes no changes — for exercising the full pipeline (workspace, verifier,
 * gates, run log) end-to-end without spawning a real agent.
 */
export class NoopHarness implements HarnessAdapter {
  readonly name = 'noop';
  async run(_prompt: string, sessionId?: SessionId): Promise<HarnessRunResult> {
    return {
      output: '(noop harness made no changes)',
      sessionId: sessionId ?? SessionIdSchema.parse('noop-session'),
      status: 'completed',
    };
  }
}

/**
 * Write an agent-authored verification file, refusing any path that escapes the workspace
 * root (the compile phase output is untrusted — this is a path-traversal boundary).
 */
async function writeWorkspaceFile(root: string, rel: string, content: string): Promise<void> {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, rel);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`refusing to write outside the workspace: ${rel}`);
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf8');
}
