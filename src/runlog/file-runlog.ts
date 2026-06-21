import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunLogHeader, RunLogEntry, type RunLog } from './runlog';

const HEADER_FILE = 'header.json';
const LOG_FILE = 'log.jsonl';

/**
 * Filesystem-backed, write-ahead JSONL run log. The header is written once; each entry is
 * appended as a single fsync'd JSON line. On read, the log is UNTRUSTED — every line is
 * re-validated with the frozen Zod schema and a corrupt line throws.
 */
export class FileRunLog implements RunLog {
  readonly #dir: string;
  #logCreated = false;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async writeHeader(header: RunLogHeader): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const path = join(this.#dir, HEADER_FILE);
    await writeFile(path, JSON.stringify(header), 'utf8');
    // fsync the header so it survives a crash before the first entry lands.
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    // fsync the directory so the new file's name is durable too.
    await this.#fsyncDir();
  }

  async append(entry: RunLogEntry): Promise<void> {
    const path = join(this.#dir, LOG_FILE);
    const handle = await open(path, 'a');
    try {
      await handle.write(`${JSON.stringify(entry)}\n`);
      // Write-ahead durability: the entry must hit disk before the Driver advances state.
      await handle.sync();
    } finally {
      await handle.close();
    }
    // The first append creates log.jsonl — fsync the directory once so its name is durable.
    if (!this.#logCreated) {
      this.#logCreated = true;
      await this.#fsyncDir();
    }
  }

  /** Best-effort directory fsync (some platforms disallow opening a dir — durability only). */
  async #fsyncDir(): Promise<void> {
    let handle;
    try {
      handle = await open(this.#dir, 'r');
    } catch {
      return;
    }
    try {
      await handle.sync();
    } catch {
      // best-effort
    } finally {
      await handle.close();
    }
  }

  async read(): Promise<{ header: RunLogHeader; entries: RunLogEntry[] } | null> {
    let headerRaw: string;
    try {
      headerRaw = await readFile(join(this.#dir, HEADER_FILE), 'utf8');
    } catch (err: unknown) {
      if (isNotFound(err)) return null;
      throw err;
    }
    let header: RunLogHeader;
    try {
      header = RunLogHeader.parse(JSON.parse(headerRaw));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`corrupt run log header in ${this.#dir}: ${msg}`);
    }

    let logRaw: string;
    try {
      logRaw = await readFile(join(this.#dir, LOG_FILE), 'utf8');
    } catch (err: unknown) {
      if (isNotFound(err)) return { header, entries: [] };
      throw err;
    }

    const lines = logRaw.split('\n');
    // The write-ahead appender always terminates each line with '\n', leaving a trailing
    // empty element after split — drop exactly that.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    const entries = lines.map((line) => RunLogEntry.parse(JSON.parse(line)));
    return { header, entries };
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
