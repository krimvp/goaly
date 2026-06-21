/**
 * Public, embeddable API. The library works headless; the CLI is just a thin caller.
 */

// Domain (ubiquitous language) + the pure orchestrator.
export * from './domain';
export * from './orchestrator';

// The Driver and composition root.
export { drive, type DriverDeps, type DriveOptions } from './driver/driver';
export {
  composeDeps,
  buildLadder,
  makeLlmProvider,
  NoopHarness,
  STATE_DIR,
  type ComposeOptions,
} from './cli/compose';
export {
  parseArgs,
  USAGE,
  UsageError,
  type ParsedArgs,
  type HarnessChoice,
  type LlmProviderChoice,
  type RawFlags,
} from './cli/args';
export {
  ModelSelection,
  resolveModels,
  type ModelSelectionInput,
  type ResolvedModels,
} from './cli/models';
export {
  resolveInputSources,
  defaultReaders,
  type InputReaders,
  type ResolvedInputs,
} from './cli/input-sources';
export { main, formatOutcome } from './cli/main';

// Seam interfaces.
export type { HarnessAdapter } from './harness/adapter';
export type { Verifier } from './verify/verifier';
export type { Approver } from './verify/approver';
export type { VerifierCompiler } from './compile/compiler';
export type { ContractGate } from './compile/gateA';
export type { Workspace, CommandResult } from './workspace/workspace';
export type { RunLog } from './runlog/runlog';
export { RunLogHeader, RunLogEntry } from './runlog/runlog';
export type { LlmProvider, LlmRequest } from './llm/provider';
export { FakeLlm } from './llm/provider';

// Seam #4 (real implementations) + concrete adapters/verifiers.
export { SystemClock, type Clock } from './driver/clock';
export { SystemBudgetMeter, type BudgetMeter } from './driver/budget';
export { GitWorkspace } from './workspace/git-workspace';
export { FileRunLog } from './runlog/file-runlog';
export { DeterministicVerifier } from './verify/deterministic';
export { Ladder } from './verify/ladder';
export { JudgeVerifier } from './verify/judge';
export { AgentApprover } from './verify/agent-approver';
export { AgentCompiler } from './compile/agent-compiler';
export { AutoContractGate, HumanContractGate } from './compile/gates';
export { ClaudeCodeAdapter, parseClaudeOutput } from './harness/claude-code';
export { CodexAdapter, parseCodexOutput, codexExtractor } from './harness/codex';
export { DroidAdapter, parseDroidOutput, droidExtractor, type AutonomyLevel } from './harness/droid';
export { CliLlmProvider, buildLlmArgs } from './llm/cli-provider';
export { AgentCliLlmProvider } from './llm/agent-cli-provider';

// Shared agent-CLI output parsing (reused by harness adapters + LLM providers).
export {
  parseAgentOutput,
  flatExtractor,
  type AgentOutput,
  type AgentFields,
  type FieldExtractor,
} from './agent-cli/output';
export { classifyHarnessRun } from './harness/classify';

// Utilities.
export { freezeContract, hashContract, sha256Hex } from './util/hash';
