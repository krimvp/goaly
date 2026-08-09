import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileDegraded } from './degraded-header';
import { FileRunLog } from '../runlog/file-runlog';
import { effectiveDegraded } from '../runlog/replay';
import type { DegradedMode } from '../domain/degraded';
import type { RunLog, RunLogEntry, RunLogHeader } from '../runlog/runlog';
import { DiffHash, RunId } from '../domain/ids';
import { makeConfig } from '../testing/fakes';
import { noopLogger } from '../log/logger';

/**
 * DURABILITY REGRESSION (invariant #7, write-ahead). The degraded-label reconciliation used to
 * REWRITE an existing run's `header.json` in place — a truncate-then-refill with no tmp+rename — so
 * a crash inside that window left a run with a torn/empty header: unreadable by `runs show`, and
 * permanently unresumable, for a run whose tree and event stream were both perfectly fine. The
 * escalated label is worth ~nothing; the run it destroyed is worth everything.
 *
 * The fix records the escalation as an APPENDED Driver-side marker (`DEGRADED_ESCALATED`, the
 * RUN_EXTENDED pattern from ADR 0012) and derives the effective label on read, so the header stays
 * written-once and the only mutation the log ever performs is an append.
 */

const runId = RunId.parse('run-degraded-header');
const unverified: DegradedMode = {
  kind: 'independence-unverified',
  model: 'gpt-5-mini',
  generate: true,
  autonomous: true,
};
const selfJudged: DegradedMode = { kind: 'self-judged', generate: true, autonomous: true };

function header(): RunLogHeader {
  return { runId, startedAt: 1, config: makeConfig({ goal: 'a goal' }), degraded: unverified };
}

function entry(seq: number): RunLogEntry {
  return {
    runId,
    seq,
    ts: seq,
    contractHash: null,
    event: { tag: 'CHECKPOINTED', tree: DiffHash.parse('0000abc') },
    stateTagAfter: 'COMPILING',
  };
}

/** What the Driver knows about the resumed log when it reconciles the label. */
function resumed(seq: number) {
  return { runId, seq, contractHash: null, stateTag: 'COMPILING', now: 99 };
}

describe('reconcileDegraded — the escalation is an APPEND, never a header rewrite', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('leaves header.json byte-identical and appends a DEGRADED_ESCALATED marker instead', async () => {
    dir = await mkdtemp(join(tmpdir(), 'goaly-degraded-'));
    const log = new FileRunLog(dir);
    await log.writeHeader(header());
    await log.append(entry(1));
    const before = await readFile(join(dir, 'header.json'), 'utf8');

    await reconcileDegraded(log, header(), selfJudged, noopLogger, resumed(1));

    expect(await readFile(join(dir, 'header.json'), 'utf8')).toBe(before);
    const stored = (await log.read())!;
    expect(stored.header.degraded).toEqual(unverified); // the header is still written ONCE
    const marker = stored.entries[stored.entries.length - 1]!;
    expect(marker.event).toEqual({ tag: 'DEGRADED_ESCALATED', degraded: selfJudged });
    expect(marker.seq).toBe(2);
    // The label a reader reports is the escalated one — derived from header + markers.
    expect(effectiveDegraded(stored.header.degraded, stored.entries)).toEqual(selfJudged);
  });

  it('a crash in the write window can no longer brick an otherwise-resumable run', async () => {
    dir = await mkdtemp(join(tmpdir(), 'goaly-degraded-'));
    const inner = new FileRunLog(dir);
    await inner.writeHeader(header());
    await inner.append(entry(1));

    // A RunLog whose header write CRASHES exactly the way the old non-atomic rewrite could: the
    // file is truncated, then the process dies before the refill lands.
    const crashing: RunLog = {
      writeHeader: async () => {
        await writeFile(join(dir!, 'header.json'), '', 'utf8');
        throw new Error('crash mid-header-write');
      },
      append: (e) => inner.append(e),
      read: () => inner.read(),
    };

    await reconcileDegraded(crashing, header(), selfJudged, noopLogger, resumed(1));

    // The run is still readable — i.e. still resumable — because nothing rewrote the header.
    const stored = await new FileRunLog(dir).read();
    expect(stored).not.toBeNull();
    expect(effectiveDegraded(stored!.header.degraded, stored!.entries)).toEqual(selfJudged);
  });

  it('never DOWNGRADES, and appends nothing when the resumed wiring is not more degraded', async () => {
    dir = await mkdtemp(join(tmpdir(), 'goaly-degraded-'));
    const log = new FileRunLog(dir);
    await log.writeHeader({ ...header(), degraded: selfJudged });
    await log.append(entry(1));

    await reconcileDegraded(log, { ...header(), degraded: selfJudged }, undefined, noopLogger, resumed(1));

    const stored = (await log.read())!;
    expect(stored.entries).toHaveLength(1);
    expect(effectiveDegraded(stored.header.degraded, stored.entries)).toEqual(selfJudged);
  });
});

describe('effectiveDegraded — header ∨ every logged escalation', () => {
  it('is the header label when no escalation was ever recorded', () => {
    expect(effectiveDegraded(unverified, [entry(1)])).toEqual(unverified);
    expect(effectiveDegraded(undefined, [entry(1)])).toBeUndefined();
  });

  it('takes the most degraded of the header and every marker, in any order', () => {
    const mark = (degraded: DegradedMode, seq: number): RunLogEntry => ({
      ...entry(seq),
      event: { tag: 'DEGRADED_ESCALATED', degraded },
    });
    expect(effectiveDegraded(undefined, [mark(unverified, 1), mark(selfJudged, 2)])).toEqual(
      selfJudged,
    );
    expect(effectiveDegraded(selfJudged, [mark(unverified, 1)])).toEqual(selfJudged);
  });
});
