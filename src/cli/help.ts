/**
 * `goaly help [<topic>|all]` — serve the usage text by topic instead of as one wall. The default
 * `goaly help` prints the quick start, the synopsis, and a topic index; `goaly help <topic>` prints
 * one section; `goaly help all` prints the whole contract. Also the single home of the
 * "documented flag" extraction that completion, the config drift test, and the docs-sync gate share.
 */
import { USAGE, USAGE_HEAD, USAGE_TOPICS, type UsageTopic } from './usage';
import { UsageError } from './flags/tokens';

/** Flag-shaped tokens in `USAGE` that are NOT goaly flags: another tool's flags and prose globs. */
const NOT_A_FLAG = new Set(['auto', 'rm', 'json', 'stuck-', 'baseline-style']);

const ALL_TOPICS = 'all';

/** Every documented `--flag` name (without the dashes), deduped and sorted — the flag contract. */
export function documentedFlagNames(): string[] {
  const names = new Set(
    [...USAGE.matchAll(/--([a-z][a-z0-9-]*)/g)]
      .map((m) => m[1] as string)
      .filter((f) => !NOT_A_FLAG.has(f)),
  );
  return [...names].sort();
}

/** The names `goaly help <topic>` accepts, in index order (used by completion). */
export function helpTopicKeys(): string[] {
  return [...USAGE_TOPICS.map((t) => t.key), ALL_TOPICS];
}

/** The help text for `topic` (undefined ⇒ the short index). Unknown topic ⇒ UsageError. */
export function renderHelp(topic: string | undefined): string {
  if (topic === undefined) return helpIndex();
  if (topic === ALL_TOPICS) return USAGE;
  const found = findTopic(topic);
  if (found === undefined) {
    throw new UsageError(
      `unknown help topic '${topic}' — topics: ${helpTopicKeys().join(', ')}`,
    );
  }
  return found.text;
}

/** Exact key first; otherwise a unique case-insensitive match on the key or the title. */
function findTopic(query: string): UsageTopic | undefined {
  const needle = query.toLowerCase();
  const exact = USAGE_TOPICS.find((t) => t.key === needle);
  if (exact !== undefined) return exact;
  const hits = USAGE_TOPICS.filter(
    (t) => t.key.includes(needle) || t.title.toLowerCase().includes(needle),
  );
  return hits.length === 1 ? hits[0] : undefined;
}

function helpIndex(): string {
  const width = Math.max(...USAGE_TOPICS.map((t) => t.key.length));
  const rows = USAGE_TOPICS.map((t) => `  ${t.key.padEnd(width)}  ${t.title}`);
  return [
    USAGE_HEAD,
    '',
    'Topics (goaly help <topic> prints one; goaly help all prints everything):',
    ...rows,
  ].join('\n');
}
