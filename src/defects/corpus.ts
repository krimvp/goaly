import { appendFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { CompiledContract } from '../domain/contract';
import type { Logger } from '../log/logger';
import { DefectLanguage, DefectRunner, contractDefectContext } from './context';

/**
 * THE DEFECT CORPUS (issue #122) — goaly's only CROSS-RUN feedback channel.
 *
 * Every other channel in the system is intra-run (verifier→worker, veto→worker, red-team→compiler,
 * …): nothing survives the run that produced it, so the compiler re-authors the same unsatisfiable
 * bar forever. This is a small, local, append-only file of ADJUDICATED contract defects, injected
 * back into the compiler's authoring prompt as "do not author these".
 *
 * Three structural properties, not conventions — each is tested:
 *
 * 1. **Only an adjudicated `CONTRACT_DEFECTIVE` verdict may write.** {@link DefectCorpus.append}
 *    accepts only an {@link AdjudicatedDefect}, a phantom-branded record type that ONLY
 *    {@link fromAdjudication} can mint — and it returns `null` for anything but `defective: true`.
 *    No other call site can even type-check an append.
 * 2. **No worker-supplied text can reach a record.** The only free text in the schema is the
 *    adjudicator's OWN generalized `pattern` / `assertionShape`; the builder's input has no field
 *    for the failure signature, the diff, harness output, or the authored file contents, and the
 *    rest of the record is derived deterministically from the FROZEN contract.
 * 3. **"This was hard" is inexpressible.** The schema is `.strict()` and carries no iteration
 *    count, no repeat count, no duration, no token spend, no severity/difficulty field. Difficulty
 *    must never become an argument for authoring an easier bar, so the corpus cannot even carry it.
 *
 * The corpus is ADVISORY and therefore FAIL-OPEN in every direction (the deliberate inverse of the
 * loop's fail-closed rule, and safe for the same reason: it is not a gate). A missing, unreadable,
 * corrupt, or partly-unparseable corpus degrades to exactly today's behavior; an append that fails
 * is logged and dropped. It can never turn a red bar green — it only shapes an authoring prompt,
 * strictly before the freeze, and the frozen ladder + veto-only approver still gate DONE.
 */

/** Schema version of one record; bumped only on an incompatible field change. */
export const DEFECT_RECORD_VERSION = 1;

/** Hard cap on any free-text field, so one record can never bloat the corpus or the prompt. */
export const MAX_DEFECT_TEXT = 240;

/**
 * One adjudicated contract defect.
 *
 * `.strict()` on purpose: an unknown key (a hand-added `difficulty`, `attempts`, `severity`, an
 * echoed diff) fails the parse and the record is DROPPED on read. The field list is the whole
 * story — a generalized pattern, the generalized shape of the offending assertion, the
 * deterministic language/runner context used to filter it, and provenance.
 */
export const DefectRecord = z
  .object({
    v: z.literal(DEFECT_RECORD_VERSION),
    /** ISO-8601 timestamp of the adjudication (recency ordering only). */
    ts: z.string().min(1),
    /** The adjudicator's ONE-SENTENCE generalized anti-pattern. Never repo text. */
    pattern: z.string().min(1).max(MAX_DEFECT_TEXT),
    /** Generalized shape of the offending assertion, when the adjudicator named one. */
    assertionShape: z.string().min(1).max(MAX_DEFECT_TEXT).optional(),
    /** Deterministically derived from the FROZEN contract — an enum, so no text can ride in. */
    language: DefectLanguage,
    /** Likewise: the test runner the frozen bar invoked. */
    runner: DefectRunner,
    /** Provenance: which frozen contract was condemned, and by which run. */
    contractHash: z.string().min(1),
    runId: z.string().min(1),
  })
  .strict();
export type DefectRecord = z.infer<typeof DefectRecord>;

declare const ADJUDICATED: unique symbol;

/**
 * A record that PROVABLY came from an adjudicated `defective: true` verdict. The brand is phantom
 * (erased at runtime) and only {@link fromAdjudication} mints it, so `append` is unreachable from
 * any other code path — the compile fails rather than a convention being broken.
 */
export type AdjudicatedDefect = DefectRecord & { readonly [ADJUDICATED]: true };

/**
 * The adjudicator's verdict, structurally. Deliberately NOT imported from the driver: the corpus
 * must not depend on the loop, and this shape names ONLY the fields a record may draw on — there
 * is no member here through which the worker's signature, diff, or output could arrive.
 */
export type AdjudicationOutcome = {
  readonly defective: boolean;
  readonly pattern?: string | undefined;
  readonly assertionShape?: string | undefined;
};

/** Everything else a record needs, all of it goaly's own facts. */
export type DefectProvenance = {
  /** The FROZEN contract that was adjudicated defective (hash + the language/runner context). */
  readonly contract: CompiledContract;
  readonly runId: string;
  /** Epoch ms, from the Driver's clock (never `Date.now()` inside the module). */
  readonly now: number;
};

/**
 * Normalize a free-text field to ONE bounded line: strip control characters, collapse whitespace,
 * drop code fences, and truncate. A pattern is meant to be a sentence; anything longer or
 * multi-line is a sign the adjudicator started quoting, so we cut it back to a bounded fragment.
 */
function sanitize(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const collapsed = text
    .replace(/```+/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length === 0) return undefined;
  return collapsed.slice(0, MAX_DEFECT_TEXT);
}

/**
 * The ONLY way to mint a writable record. Returns `null` — never throws, never a partial record —
 * unless the verdict is a positive adjudication carrying a usable generalized pattern.
 */
export function fromAdjudication(
  verdict: AdjudicationOutcome,
  provenance: DefectProvenance,
): AdjudicatedDefect | null {
  if (!verdict.defective) return null;
  const pattern = sanitize(verdict.pattern);
  if (pattern === undefined) return null;
  const shape = sanitize(verdict.assertionShape);
  const context = contractDefectContext(provenance.contract);
  const record: DefectRecord = {
    v: DEFECT_RECORD_VERSION,
    ts: new Date(provenance.now).toISOString(),
    pattern,
    ...(shape !== undefined ? { assertionShape: shape } : {}),
    language: context.language,
    runner: context.runner,
    contractHash: provenance.contract.contractHash,
    runId: provenance.runId,
  };
  const parsed = DefectRecord.safeParse(record);
  if (!parsed.success) return null; // belt & braces: a record that could not be read back is not written
  return parsed.data as AdjudicatedDefect;
}

/**
 * The corpus seam. `read` is synchronous (a handful of short lines, read once at composition time
 * like the workspace facts); `append` is async because the Driver performs it as an effect.
 * Neither ever throws — the corpus is advisory.
 */
export interface DefectCorpus {
  /** Where the corpus lives (surfaced by `goaly config defects list` and the injection log). */
  readonly path: string;
  /** Zod-parse every line, DROPPING anything unparseable. Never throws; `[]` when absent. */
  read(): readonly DefectRecord[];
  /** Append one adjudicated record. Never throws (a failed write degrades to "not learned"). */
  append(record: AdjudicatedDefect): Promise<void>;
  /** Reset the corpus (`goaly config defects clear`). Never throws. */
  clear(): Promise<void>;
}

/** `~/.goaly/defects.jsonl` — outside any single run, so learning compounds across them. */
export function defaultDefectCorpusPath(): string {
  return path.join(os.homedir(), '.goaly', 'defects.jsonl');
}

/** JSONL file corpus. Every operation is fail-open; a broken file is treated as an empty one. */
export class FileDefectCorpus implements DefectCorpus {
  readonly path: string;

  constructor(filePath: string = defaultDefectCorpusPath()) {
    this.path = filePath;
  }

  read(): readonly DefectRecord[] {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return []; // missing / unreadable ⇒ today's behavior
    }
    const records: DefectRecord[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let json: unknown;
      try {
        json = JSON.parse(trimmed);
      } catch {
        continue; // a torn or corrupt line is dropped, the rest still counts
      }
      const parsed = DefectRecord.safeParse(json);
      if (parsed.success) records.push(parsed.data);
    }
    return records;
  }

  async append(record: AdjudicatedDefect): Promise<void> {
    try {
      await mkdir(path.dirname(this.path), { recursive: true });
      await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // Fail-open: a corpus we cannot write is a corpus that did not learn — never a failed run.
    }
  }

  async clear(): Promise<void> {
    try {
      await rm(this.path, { force: true });
    } catch {
      // Same: nothing here may throw into a CLI command.
    }
  }
}

/**
 * The one sanctioned write path: mint a record from an adjudication and append it. Returns the
 * record actually written (for logging/tests) or `null` when the verdict did not earn one — a
 * `defective: false` adjudication, or a positive one with no generalized pattern to store.
 */
export async function appendAdjudicatedDefect(
  corpus: DefectCorpus,
  verdict: AdjudicationOutcome,
  provenance: DefectProvenance,
  logger?: Logger,
): Promise<DefectRecord | null> {
  const record = fromAdjudication(verdict, provenance);
  if (record === null) return null;
  try {
    await corpus.append(record);
  } catch (e) {
    // The seam promises not to throw, but the corpus is ADVISORY: guard it anyway so even a
    // broken implementation degrades to "this run taught nothing" instead of failing the run.
    logger?.warn('defect corpus: could not record the adjudicated defect', {
      reason: e instanceof Error ? e.message : String(e),
      path: corpus.path,
    });
    return null;
  }
  logger?.info('defect corpus: recorded an adjudicated contract defect', {
    pattern: record.pattern,
    language: record.language,
    runner: record.runner,
    path: corpus.path,
  });
  return record;
}
