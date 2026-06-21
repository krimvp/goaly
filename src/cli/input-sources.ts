import { readFile as fsReadFile } from 'node:fs/promises';
import type { RawFlags } from './args';
import { UsageError } from './args';

/**
 * The IO seam for goal/intent/rubric input. Kept injectable so `parseArgs` stays testable
 * without touching the filesystem or the real stdin stream. This is the ONLY place CLI input
 * IO happens; everything downstream sees plain strings.
 */
export type InputReaders = {
  readFile(path: string): Promise<string>;
  readStdin(): Promise<string>;
};

/** Production readers: the filesystem and the process's stdin stream. */
export const defaultReaders: InputReaders = {
  readFile: (p) => fsReadFile(p, 'utf8'),
  readStdin: drainStdin,
};

async function drainStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The goal-bearing fields that may be sourced inline, from a file, or from stdin. */
const FIELDS = ['goal', 'intent', 'rubric'] as const;
type Field = (typeof FIELDS)[number];

export type ResolvedInputs = { goal?: string; intent?: string; rubric?: string };

type Source = 'inline' | 'file' | 'stdin';

/**
 * Resolve goal/intent/rubric from their inline flag (`--goal "x"`), a file (`--goal-file p`),
 * or stdin (`--goal -`). Rules, enforced fail-closed at this boundary:
 *  - exactly one source per field (more than one is a usage error);
 *  - stdin may feed at most one field (it is a single stream, drained once);
 *  - a file read failure becomes a usage error (never an unhandled rejection).
 * Conflicts are detected BEFORE any IO; file/stdin reads have their trailing newline trimmed.
 */
export async function resolveInputSources(
  flags: RawFlags,
  readers: InputReaders,
): Promise<ResolvedInputs> {
  const plan: { field: Field; source: Source; value: string }[] = [];
  let stdinField: Field | undefined;

  for (const field of FIELDS) {
    const inline = flags[field];
    const fileFlag = flags[`${field}-file`];
    const isStdin = inline === '-';

    const sources: Source[] = [];
    if (inline !== undefined && !isStdin) sources.push('inline');
    if (isStdin) sources.push('stdin');
    if (fileFlag !== undefined) sources.push('file');

    if (sources.length === 0) continue;
    if (sources.length > 1) {
      throw new UsageError(
        `--${field} has more than one source (use exactly one of an inline value, ` +
          `--${field}-file <path>, or stdin via --${field} -)`,
      );
    }

    const source = sources[0]!;
    if (source === 'inline') {
      if (typeof inline !== 'string') throw new UsageError(`--${field} expects a value`);
      plan.push({ field, source, value: inline });
    } else if (source === 'file') {
      if (typeof fileFlag !== 'string') throw new UsageError(`--${field}-file expects a path`);
      plan.push({ field, source, value: fileFlag });
    } else {
      if (stdinField !== undefined) {
        throw new UsageError(
          `stdin can feed only one field, but both --${stdinField} - and --${field} - request it`,
        );
      }
      stdinField = field;
      plan.push({ field, source, value: '' });
    }
  }

  const resolved: ResolvedInputs = {};
  for (const { field, source, value } of plan) {
    if (source === 'inline') {
      resolved[field] = value;
    } else if (source === 'file') {
      resolved[field] = (await readFileOrThrow(readers, value)).trimEnd();
    } else {
      resolved[field] = (await readers.readStdin()).trimEnd();
    }
  }
  return resolved;
}

async function readFileOrThrow(readers: InputReaders, path: string): Promise<string> {
  try {
    return await readers.readFile(path);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new UsageError(`could not read '${path}': ${msg}`);
  }
}
