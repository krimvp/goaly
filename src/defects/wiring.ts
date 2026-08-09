import os from 'node:os';
import path from 'node:path';
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
export const DEFECT_TRUST_RELOCATED =
  'signed only against hand-edited/copied/foreign lines — --defect-corpus put the corpus and its ' +
  'signing key OUTSIDE the $HOME/.goaly directory a --sandbox policy masks, so the jail does not ' +
  'put the key beyond the agent seam\'s reach; these hints are contained by the untrusted fence, ' +
  'not by the signature';

/**
 * Which of the three provenance claims is TRUE for this run.
 *
 * The mask claim ({@link DEFECT_TRUST_SANDBOXED}) is about one specific directory: `DENIED_HOME_SECRETS`
 * masks `$HOME/.goaly` and nothing else, while the workspace is bound read-write for the agent. So
 * `sandboxed` alone does not establish it — `--defect-corpus <workspace>/team-defects.jsonl` (the
 * shape the docs advertise) resolves its key to `<workspace>/team-defects.key`, inside the very tree
 * the agent can write. Selecting the string from the boolean therefore asserted, as per-run
 * diagnostics, a containment the jail does not provide.
 *
 * Exported (and given an explicit `homeDir`) so the masked case is pinnable without a test ever
 * touching a developer's real `~/.goaly`.
 */
export function defectTrust(
  sandboxed: boolean,
  keyPath: string,
  homeDir: string = os.homedir(),
): string {
  if (!sandboxed) return DEFECT_TRUST_FENCED_ONLY;
  const masked = path.resolve(homeDir, '.goaly');
  const key = path.resolve(keyPath);
  const inside = key === masked || key.startsWith(`${masked}${path.sep}`);
  return inside ? DEFECT_TRUST_SANDBOXED : DEFECT_TRUST_RELOCATED;
}

/**
 * Resolve the corpus for a run. Fail-open by construction: `read()` swallows a missing/corrupt
 * file, and the only thing an empty result changes is that no section is injected — i.e. exactly
 * today's behavior. Logs which patterns were injected (the issue's reproducibility answer: the
 * hidden local state that shaped the bar is named in the run's own diagnostics) — and, in the same
 * line, HOW MUCH that provenance is worth on this run, because the answer differs by sandbox policy
 * AND by where the corpus lives (see {@link defectTrust}) and a reader should not have to
 * reconstruct it. `sandboxed` is `true` when a real jail is in force (any launcher but the identity
 * passthrough) — on its own that does NOT establish that the jail hides the signing key.
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
      trust: defectTrust(sandboxed, corpus.keyPath),
    });
  }
  return { corpus, section: formatDefectSection(hints) };
}
