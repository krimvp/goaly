import type { AgentCliCodec } from './codec';
import { claudeCodec } from './claude-codec';
import { codexCodec } from './codex-codec';
import { droidCodec, makeDroidCodec, type AutonomyLevel } from './droid-codec';
import { piCodec } from './pi-codec';

/**
 * The bundled coding-agent CLIs goaly can speak to. ONE name per CLI, shared by BOTH roles a CLI can
 * play — the write-role harness (seam #1) and the read-only LLM provider (judge/approver/compiler).
 * The harness adds a `'fake'` (a NoopHarness, no codec); the LLM provider is exactly this set.
 */
export type AgentCli = 'claude' | 'codex' | 'droid' | 'pi';

const AGENT_CLIS: ReadonlySet<string> = new Set<AgentCli>(['claude', 'codex', 'droid', 'pi']);

/** Type guard: is this harness/provider name one of the bundled agent CLIs (i.e. has a codec)? */
export function isAgentCli(name: string): name is AgentCli {
  return AGENT_CLIS.has(name);
}

/**
 * Per-run knobs a codec may honour. Every field is OPTIONAL and every codec is free to ignore one it
 * has no analogue for — a knob is only ever a refinement of the codec's own default, never a new
 * requirement. Kept deliberately small: this is pure WIRING (like `--model`), so nothing here may
 * reach the frozen contract.
 */
export type CodecOptions = {
  /**
   * Write-role autonomy for CLIs that gate privileged actions behind a tier (`droid --auto`).
   * Omitted ⇒ the codec's own default. Only the droid codec consumes it today; the read-only LLM
   * role never does (it stays at the CLI's read-only default by construction).
   */
  readonly autonomy?: AutonomyLevel | undefined;
};

/**
 * The single source of truth mapping a CLI name to its {@link AgentCliCodec}. Both the harness
 * (`AgentCliHarness(codecFor(c))`), the sandbox exec, and the read-only LLM provider
 * (`AgentCliLlmProvider({ codec: codecFor(c) })`) resolve their codec through here, so the
 * name→codec map is written ONCE and the three paths can never drift. Adding a CLI is one codec
 * module + one case here.
 *
 * `opts` carries per-run knobs (see {@link CodecOptions}). Callers that only need the
 * autonomy-INDEPENDENT surface — `command` / `promptOnStdin` (preflight, the sandbox exec) or
 * `interactiveResume` (`goaly runs resume-cmd`) — deliberately omit it and get the default
 * singletons, so the common path allocates nothing.
 */
export function codecFor(cli: AgentCli, opts?: CodecOptions): AgentCliCodec {
  switch (cli) {
    case 'claude':
      return claudeCodec;
    case 'codex':
      return codexCodec;
    case 'droid':
      // The default singleton keeps `low`; an explicit level builds a codec for this run only.
      return opts?.autonomy === undefined ? droidCodec : makeDroidCodec(opts.autonomy);
    case 'pi':
      return piCodec;
  }
}
