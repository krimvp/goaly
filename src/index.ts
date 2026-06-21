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
  type RunsCommand,
  type StepTimeouts,
  type RawFlags,
} from './cli/args';
export { runRuns, renderRunsTable, renderRunDetail } from './cli/runs';
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
export {
  loadConfig,
  overlayFromConfig,
  defaultConfigFileReader,
  IMPLICIT_CONFIG_FILENAME,
  type ConfigFileReader,
  type LoadedConfig,
} from './cli/config-file';
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
export { replay, type ReplayResult } from './runlog/replay';
export {
  listRuns,
  readRun,
  runSummary,
  runDetail,
  type RunStatus,
  type RunSummary,
  type RunDetail,
  type IterationDetail,
  type RunListItem,
  type RunReadResult,
} from './runlog/inspect';
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

// Diagnostic logging seam (human-facing observability; NOT the durable run log).
export {
  StructuredLogger,
  noopLogger,
  LogLevel,
  LOG_LEVELS,
  LEVEL_SEVERITY,
  type Logger,
  type LogSink,
  type LogRecord,
  type LogFields,
} from './log/logger';
export {
  ConsoleSink,
  RotatingFileSink,
  nodeLogFs,
  jsonLine,
  prettyLine,
  type LogFs,
} from './log/sinks';
export { buildLogger, type BuildLoggerOptions, type FileLogOptions } from './log/build';

// Utilities.
export { freezeContract, hashContract, sha256Hex } from './util/hash';
