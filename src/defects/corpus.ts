import { appendFile, mkdir, rm } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
 *    No other call site can even type-check an append. The brand is a COMPILE-time gate over
 *    goaly's own call sites, so it says nothing about a line that simply APPEARS in the file: the
 *    corpus lives outside the workspace (outside the run diff, the generated-files integrity guard,
 *    and anything an operator reviews at Seal) and the default sandbox policy leaves the coding
 *    agent ordinary shell write access to it. So the READ side does not trust the file's contents as
 *    provenance either: every record is HMAC-signed with a key minted on first use beside the corpus
 *    (`defects.key`, private mode), and {@link FileDefectCorpus.read} DROPS every line it cannot
 *    verify. Fail-closed to "no hints", never to "trust it" — and a missing/unverifiable corpus is
 *    still exactly today's no-hints behavior, so nothing about a run is blocked by it.
 * 2. **No worker-supplied text can reach a record.** The only free text in the schema is the
 *    adjudicator's OWN generalized `pattern` / `assertionShape`; the builder's input has no field
 *    for the failure signature, the diff, harness output, or the authored file contents, and the
 *    rest of the record is derived deterministically from the FROZEN contract. That text is still
 *    MODEL-authored (and the adjudicator read worker output to write it), so the prompt section that
 *    renders it is fenced as UNTRUSTED data — see `formatDefectSection`.
 * 3. **"This was hard" is inexpressible.** The schema is `.strict()` and carries no iteration
 *    count, no repeat count, no duration, no token spend, no severity/difficulty field. Difficulty
 *    must never become an argument for authoring an easier bar, so the corpus cannot even carry it.
 *    The free text cannot smuggle it back in either: a `pattern`/`assertionShape` mentioning effort,
 *    difficulty, iterations, attempts, time, cost or complexity is REFUSED by the schema itself
 *    ({@link mentionsEffort}) — on mint and on read — rather than by an instruction in the
 *    adjudicator's system prompt.
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
 * The closed effort/difficulty vocabulary that may NOT appear in a record's free text.
 *
 * Property 3 above is about the SHAPE of the record, but `pattern` is 240 characters of adjudicator
 * free text: "this bar was too hard for the agent" parses as happily as a real anti-pattern, and
 * would then be rendered verbatim into an authoring prompt as a reason to author a weaker bar. One
 * sentence in the adjudicator's system prompt is a convention; this is the structural half.
 *
 * Deliberately small, and deliberately biased toward over-rejection: dropping a legitimate hint
 * whose wording happens to mention "time" or "hard-coded" costs nothing (the corpus is advisory and
 * fail-open — the run proceeds with one fewer hint), while letting an effort argument through
 * corrupts the one channel that shapes every future bar.
 */
const EFFORT_VOCABULARY =
  /\b(?:hard|harder|hardest|difficult|difficulty|effort|efforts|iteration|iterations|attempt|attempts|time|times|expensive|token|tokens|complex|complexity|too\s+many)\b/i;

/** True when free text argues from effort/difficulty/cost rather than from impossibility. */
export function mentionsEffort(text: string): boolean {
  return EFFORT_VOCABULARY.test(text);
}

/** A bounded, single-sentence free-text field that cannot express difficulty. */
const GeneralizedText = z
  .string()
  .min(1)
  .max(MAX_DEFECT_TEXT)
  .refine((t) => !mentionsEffort(t), {
    message: 'effort/difficulty language cannot be expressed in the defect corpus',
  });

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
    pattern: GeneralizedText,
    /** Generalized shape of the offending assertion, when the adjudicator named one. */
    assertionShape: GeneralizedText.optional(),
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
  // Refused at MINT time, not just on read: an adjudicator that argues from effort/difficulty
  // teaches the corpus nothing about impossibility, and must not be able to teach it "author an
  // easier bar" either. Dropping the whole record (rather than the offending field) keeps the
  // remaining text honest — the shape is the pattern's evidence.
  if (pattern === undefined || mentionsEffort(pattern)) return null;
  const shape = sanitize(verdict.assertionShape);
  if (shape !== undefined && mentionsEffort(shape)) return null;
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

/**
 * The signing key that makes a corpus line provenance instead of a wish: `defects.key` beside the
 * corpus file (so `--defect-corpus <path>` keeps its own key, and the default lives in `~/.goaly`,
 * outside every workspace). Minted on first append with private permissions; never written into the
 * corpus and never printed.
 */
export function defaultDefectCorpusKeyPath(corpusPath: string): string {
  const dir = path.dirname(corpusPath);
  const base = path.basename(corpusPath).replace(/\.jsonl$/i, '');
  return path.join(dir, `${base}.key`);
}

/** One stored line: the record plus its detached HMAC. `.strict()` is inherited — no other key. */
const SignedDefectRecord = DefectRecord.extend({ sig: z.string().min(1) });

const KEY_BYTES = 32;

/** Read an existing key; `undefined` when absent, unreadable, or not a well-formed key. */
function readKey(keyPath: string): Buffer | undefined {
  try {
    const hex = readFileSync(keyPath, 'utf8').trim();
    if (!new RegExp(`^[0-9a-f]{${KEY_BYTES * 2}}$`).test(hex)) return undefined;
    return Buffer.from(hex, 'hex');
  } catch {
    return undefined;
  }
}

/**
 * Read the key, minting one on first use. `wx` so two concurrent drivers cannot clobber each
 * other's key (the loser re-reads the winner's). Returns `undefined` when no key can be
 * established — the caller then simply does not write, which is the corpus's fail-open behavior.
 */
function ensureKey(keyPath: string): Buffer | undefined {
  const existing = readKey(keyPath);
  if (existing !== undefined) return existing;
  const minted = randomBytes(KEY_BYTES);
  try {
    mkdirSync(path.dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, `${minted.toString('hex')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    return minted;
  } catch {
    return readKey(keyPath); // lost the race, or cannot write at all
  }
}

/**
 * The exact bytes that are signed: every field, in a FIXED order, independent of how the object was
 * constructed or re-serialized. Signing a positional array (rather than the JSON line) means a
 * re-ordered or re-formatted line still verifies, while any change to a VALUE does not.
 */
function signedPayload(record: DefectRecord): string {
  return JSON.stringify([
    record.v,
    record.ts,
    record.pattern,
    record.assertionShape ?? null,
    record.language,
    record.runner,
    record.contractHash,
    record.runId,
  ]);
}

function sign(record: DefectRecord, key: Buffer): string {
  return createHmac('sha256', key).update(signedPayload(record)).digest('hex');
}

function verify(record: DefectRecord, sig: string, key: Buffer): boolean {
  const expected = Buffer.from(sign(record, key), 'hex');
  const actual = Buffer.from(sig, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** JSONL file corpus. Every operation is fail-open; a broken file is treated as an empty one. */
export class FileDefectCorpus implements DefectCorpus {
  readonly path: string;
  /** The HMAC key file (see {@link defaultDefectCorpusKeyPath}); never part of the corpus. */
  readonly keyPath: string;

  constructor(filePath: string = defaultDefectCorpusPath(), keyPath?: string) {
    this.path = filePath;
    this.keyPath = keyPath ?? defaultDefectCorpusKeyPath(filePath);
  }

  read(): readonly DefectRecord[] {
    // No key ⇒ nothing in the file is verifiable ⇒ no hints. Fail-CLOSED on provenance (a corpus
    // whose lines cannot be attributed to an adjudication of ours teaches nothing), which is still
    // fail-OPEN for the run: "no hints" is exactly the pre-corpus behavior.
    const key = readKey(this.keyPath);
    if (key === undefined) return [];
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
      const parsed = SignedDefectRecord.safeParse(json);
      if (!parsed.success) continue;
      const { sig, ...record } = parsed.data;
      if (verify(record, sig, key)) records.push(record);
    }
    return records;
  }

  async append(record: AdjudicatedDefect): Promise<void> {
    try {
      await mkdir(path.dirname(this.path), { recursive: true });
      const key = ensureKey(this.keyPath);
      if (key === undefined) return; // unsignable ⇒ unverifiable ⇒ not written at all
      const line = JSON.stringify({ ...(record as DefectRecord), sig: sign(record, key) });
      await appendFile(this.path, `${line}\n`, 'utf8');
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
