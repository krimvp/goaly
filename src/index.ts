/**
 * Public, embeddable API. The library works headless; the CLI is just a thin caller.
 */

// Domain (ubiquitous language) + the pure orchestrator.
export * from './domain';
export * from './orchestrator';

// The Driver and composition root.
export {
  drive,
  recordCheckpoint,
  type DriverDeps,
  type DriveOptions,
  type CheckpointDeps,
} from './driver/driver';
export {
  composeDeps,
  buildLadder,
  makeLlmProvider,
  NoopHarness,
  EndpointConfigError,
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
export { formatUsage } from './cli/usage-format';
export {
  parsePriceTable,
  computeCost,
  PriceTable,
  PriceEntry,
  CategoryRates,
  DEFAULT_PRICE_KEY,
  type CostView,
} from './cli/cost';

// Seam interfaces.
export type { HarnessAdapter } from './harness/adapter';
export type { Verifier } from './verify/verifier';
export type { Approver } from './verify/approver';
export type { VerifierCompiler } from './compile/compiler';
export type { SealGate } from './compile/seal';
export type { Planner } from './plan/planner';
export type { PlanGate } from './plan/plan-gate';
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
export type { LlmProvider, LlmRequest, LlmCompletion } from './llm/provider';
export { FakeLlm } from './llm/provider';

// goaly-code harness transport (Slice 0): the OpenAI-compatible chat-completions client + the read-only
// provider on top of it (judge/approver/compiler against any such endpoint, no coding CLI installed).
export {
  OpenAiClient,
  LlmClientError,
  DEFAULT_LLM_HTTP_TIMEOUT_MS,
  type LlmClient,
  type ChatResult,
  type FetchLike,
  type OpenAiClientOptions,
} from './llm-client/openai-client';
export {
  ChatMessage,
  ChatToolCall,
  ChatTool,
  ChatRequest,
  ChatResponse,
  ChatUsage,
  usageToBreakdown,
} from './llm-client/schema';
export { OpenAiLlmProvider } from './llm/openai-provider';

// goaly-code harness (Slice 1): the first NON-codec HarnessAdapter — goaly's own tool-use loop driving an
// OpenAI-compatible endpoint, behind `--harness goaly-code`. The leaves are exported for embedders/tests.
export { GoalyCodeHarness, DEFAULT_GOALY_CODE_MAX_TURNS, type GoalyCodeHarnessOptions } from './goaly-code/harness';
export { runAgentLoop, type LoopResult, type LoopTokens, type RunAgentLoopOptions } from './goaly-code/loop';
export {
  DEFAULT_TOOLS,
  dispatchTool,
  toApiTools,
  type ToolHost,
  type ToolSpec,
  type ToolOutcome,
} from './goaly-code/tools';
export { applyEdit, type EditResult } from './goaly-code/edit';
export { NodeToolHost, type ShellExec } from './goaly-code/fs-host';
export {
  FileSessionStore,
  InMemorySessionStore,
  sessionFileName,
  type SessionStore,
  type SessionFs,
} from './goaly-code/session-store';
export { GOALY_CODE_SYSTEM_PROMPT } from './goaly-code/prompt';

// Training arc (Slices 2–3): export labeled trajectories from runs, assemble a rejection-sampling SFT
// dataset, and the held-out eval bench. The ladder + approver are the label — for free.
export {
  exportRunTrajectory,
  buildTrajectoryRecord,
  lastSessionId,
  type TrajectoryRecord,
  type LadderOutcome,
} from './training/trajectory';
export {
  selectPassing,
  toSftExample,
  toSftJsonl,
  datasetStats,
  type SftExample,
  type SelectOptions,
  type DatasetStats,
} from './training/dataset';
export {
  BENCH_TASKS,
  runBench,
  summarizeBench,
  type BenchTask,
  type BenchResult,
  type BenchSummary,
  type RunTaskFn,
} from './training/bench';

// Seam #4 (real implementations) + concrete adapters/verifiers.
export { SystemClock, type Clock } from './driver/clock';
export { SystemBudgetMeter, type BudgetMeter } from './driver/budget';
export { LlmTokenMeter, meterLlm, deltaToUsage, type LlmDelta } from './driver/llm-meter';
export { summarizeUsage } from './runlog/usage';
export { GitWorkspace } from './workspace/git-workspace';
export { FileRunLog } from './runlog/file-runlog';
export { DeterministicVerifier } from './verify/deterministic';
export { Ladder } from './verify/ladder';
export { JudgeVerifier } from './verify/judge';
export { AgentApprover } from './verify/agent-approver';
export { AgentCompiler } from './compile/agent-compiler';
export { AutoSealGate, HumanSealGate } from './compile/seal-gates';
export { AgentPlanner } from './plan/agent-planner';
export { StaticPlanner, type PlanFileReader } from './plan/static-planner';
export { AutoPlanGate, HumanPlanGate } from './plan/plan-gates';
export { AgentCliHarness } from './harness/agent-cli-harness';
export { AgentCliLlmProvider } from './llm/agent-cli-provider';
// The single source of truth mapping a CLI name to its codec, consumed by BOTH roles a CLI plays
// (write-role AgentCliHarness + read-only AgentCliLlmProvider). A new CLI is one codec + one case.
export { codecFor, type AgentCli } from './agent-cli/registry';

// Shared agent-CLI output parsing (reused by harness adapters + LLM providers).
export {
  parseAgentOutput,
  flatExtractor,
  type AgentOutput,
  type AgentFields,
  type FieldExtractor,
} from './agent-cli/output';
export { classifyHarnessRun } from './harness/classify';

// One deep codec per CLI: the per-tool argv dialects + field/stream extractors + status mapping,
// consumed by BOTH the write-role HarnessAdapter and the read-only AgentCliLlmProvider.
export {
  classifyFlatRun,
  runCodecHarness,
  defaultAgentExec,
  DEFAULT_AGENT_TIMEOUT_MS,
  type AgentCliCodec,
  type AgentExecFn,
  type AgentExecResult,
  type CodecClassifyInput,
} from './agent-cli/codec';
export { claudeCodec } from './agent-cli/claude-codec';
export { codexCodec } from './agent-cli/codex-codec';
export { droidCodec, makeDroidCodec, DEFAULT_AUTONOMY, type AutonomyLevel } from './agent-cli/droid-codec';
export { piCodec } from './agent-cli/pi-codec';

// Local token ESTIMATION (issue #24): the fallback when a streamed run/step self-reports no usage.
export {
  estimateTokens,
  accountTokens,
  streamingEstimator,
  StreamTokenEstimator,
  CHARS_PER_TOKEN,
  type TokenAccounting,
} from './agent-cli/estimate';

// Streaming tap (issue #23): the canonical intermediate-turn taxonomy + the shared StreamTap,
// reused by harness adapters AND the read-only LLM providers, plus the driver-side renderers.
export {
  AgentStreamEvent,
  StreamTap,
  StreamPhase,
  flatStreamExtractor,
  sdkStreamExtractor,
  usageEventFromBlock,
  type StreamEventExtractor,
  type AgentEventSink,
  type PhasedStreamSink,
} from './agent-cli/stream';
export {
  renderStreamLine,
  streamLogFields,
  makeStreamRenderer,
  type StreamRendererOptions,
} from './cli/stream-render';

// Durable, standardized cross-agent stream transcript (issue #28): the canonical stream persisted
// per-run as JSONL for offline replay — a SEPARATE file from the write-ahead run log, never the
// state source. `readStreamTranscript` is the embedder-facing offline reader; the sink is exported
// so an embedder can persist its own stream subscription the same way.
export {
  StreamTranscriptSink,
  StreamTranscriptEntry,
  readStreamTranscript,
  STREAM_FILE,
  type StreamTranscriptOptions,
} from './runlog/stream-transcript';

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
export { freezeContract, hashContract, freezePlan, hashPlan, sha256Hex } from './util/hash';
