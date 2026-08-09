import type { Logger } from '../log/logger';
import { FileDefectCorpus, defaultDefectCorpusPath, type DefectCorpus } from './corpus';
import { workspaceDefectContext } from './context';
import { DEFAULT_DEFECT_HINT_CAP, formatDefectSection, selectDefectHints } from './select';

/**
 * The composition-time half of the defect corpus: read it once, pick the relevant bounded subset
 * for this workspace, and hand back BOTH ends of the loop — the writer the Driver gives to the
 * adjudication, and the prompt section the compiler injects.
 *
 * Lives here (not in `compose.ts`) so the policy — where the corpus lives, what "relevant" means,
 * how loudly the injection is logged — is one testable unit, and the composition root stays about
 * wiring seams together.
 */

/** `--no-defect-corpus` / `--defect-corpus <path>`, resolved at the CLI seam. */
export type DefectCorpusOptions = {
  /** False ⇒ the escape hatch: nothing is read, nothing is injected, nothing is ever written. */
  readonly enabled: boolean;
  /** Override the corpus file. Absent ⇒ `~/.goaly/defects.jsonl`. */
  readonly path?: string | undefined;
};

export type ResolvedDefectCorpus = {
  /** The writer handed to the Driver; `undefined` when disabled (no corpus ⇒ no writes at all). */
  readonly corpus: DefectCorpus | undefined;
  /** Ready-to-inject authoring-prompt section; `''` when disabled, empty, or irrelevant. */
  readonly section: string;
};

/**
 * How much a run may believe about the provenance of the lines it just injected. Logged verbatim so
 * a reader of the diagnostics never has to infer it — see {@link resolveDefectCorpus}.
 */
export const DEFECT_TRUST_SANDBOXED =
  'signed, and an active --sandbox policy masks $HOME/.goaly so the agent seam cannot read the ' +
  'signing key';
export const DEFECT_TRUST_FENCED_ONLY =
  'signed only against hand-edited/copied/foreign lines — with --sandbox none the coding agent runs ' +
  'as the same uid and can read the signing key, so these hints are contained by the untrusted ' +
  'fence, not by the signature';

/**
 * Resolve the corpus for a run. Fail-open by construction: `read()` swallows a missing/corrupt
 * file, and the only thing an empty result changes is that no section is injected — i.e. exactly
 * today's behavior. Logs which patterns were injected (the issue's reproducibility answer: the
 * hidden local state that shaped the bar is named in the run's own diagnostics) — and, in the same
 * line, HOW MUCH that provenance is worth on this run, because the answer differs by sandbox policy
 * and a reader should not have to reconstruct it. `sandboxed` is `true` when a real jail is in
 * force (any launcher but the identity passthrough).
 */
export function resolveDefectCorpus(
  options: DefectCorpusOptions | undefined,
  workspaceRoot: string,
  logger: Logger,
  cap: number = DEFAULT_DEFECT_HINT_CAP,
  sandboxed: boolean = false,
): ResolvedDefectCorpus {
  if (options !== undefined && !options.enabled) {
    logger.debug('defect corpus disabled (--no-defect-corpus): no patterns read or recorded', {});
    return { corpus: undefined, section: '' };
  }
  const corpus = new FileDefectCorpus(options?.path ?? defaultDefectCorpusPath());
  const hints = selectDefectHints(corpus.read(), workspaceDefectContext(workspaceRoot), cap);
  if (hints.length > 0) {
    logger.info('defect corpus: injecting known false-red patterns into contract authoring', {
      path: corpus.path,
      count: hints.length,
      patterns: hints.map((h) => h.text),
      trust: sandboxed ? DEFECT_TRUST_SANDBOXED : DEFECT_TRUST_FENCED_ONLY,
    });
  }
  return { corpus, section: formatDefectSection(hints) };
}
