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
 * Resolve the corpus for a run. Fail-open by construction: `read()` swallows a missing/corrupt
 * file, and the only thing an empty result changes is that no section is injected — i.e. exactly
 * today's behavior. Logs which patterns were injected (the issue's reproducibility answer: the
 * hidden local state that shaped the bar is named in the run's own diagnostics).
 */
export function resolveDefectCorpus(
  options: DefectCorpusOptions | undefined,
  workspaceRoot: string,
  logger: Logger,
  cap: number = DEFAULT_DEFECT_HINT_CAP,
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
    });
  }
  return { corpus, section: formatDefectSection(hints) };
}
