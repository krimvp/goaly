import type { AgentCliCodec } from './codec';
import { claudeCodec } from './claude-codec';
import { codexCodec } from './codex-codec';
import { droidCodec } from './droid-codec';
import { piCodec } from './pi-codec';

/**
 * The bundled coding-agent CLIs goaly can speak to. ONE name per CLI, shared by BOTH roles a CLI can
 * play — the write-role harness (seam #1) and the read-only LLM provider (judge/approver/compiler).
 * The harness adds a `'fake'` (a NoopHarness, no codec); the LLM provider is exactly this set.
 */
export type AgentCli = 'claude' | 'codex' | 'droid' | 'pi';

/**
 * The single source of truth mapping a CLI name to its {@link AgentCliCodec}. Both the harness
 * (`AgentCliHarness(codecFor(c))`), the sandbox exec, and the read-only LLM provider
 * (`AgentCliLlmProvider({ codec: codecFor(c) })`) resolve their codec through here, so the
 * name→codec map is written ONCE and the three paths can never drift. Adding a CLI is one codec
 * module + one case here.
 */
export function codecFor(cli: AgentCli): AgentCliCodec {
  switch (cli) {
    case 'claude':
      return claudeCodec;
    case 'codex':
      return codexCodec;
    case 'droid':
      return droidCodec;
    case 'pi':
      return piCodec;
  }
}
