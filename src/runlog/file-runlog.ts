import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RunLogHeader, RunLogEntry, type RunLog } from './runlog';

const HEADER_FILE = 'header.json';
const LOG_FILE = 'log.jsonl';

/**
 * Filesystem-backed, write-ahead JSONL run log. The header is written once; each entry is
 * appended as a single fsync'd JSON line. On read, the log is UNTRUSTED — every terminated line
 * is re-validated with the frozen Zod schema and a corrupt line throws.
 *
 * Torn-tail tolerance: the appender always terminates a committed entry with `\n` BEFORE its
 * fsync returns, so an UNTERMINATED final line can only be the torn remnant of an append that a
 * crash / power loss / SIGKILL cut short — an entry whose state transition never became durable.
 * Write-ahead semantics make dropping it exactly right (the Driver re-performs that one effect on
 * resume — at-least-once by design), so `read()` drops a torn tail instead of rejecting the whole
 * log, and `append()` truncates it before writing so it can never fuse with the next entry. A
 * TERMINATED line that fails to parse is still real corruption and still throws (invariant #6).
 */
export class FileRunLog implements RunLog {
  readonly #dir: string;
  #logCreated = false;
  /** Set once the torn-tail check ran for this process, so appends pay it only once. */
  #tailChecked = false;

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
    // Repair a torn tail from a previous crashed process ONCE before this process's first append,
    // so the new entry starts on a fresh line and can never fuse with a torn remnant into one
    // unparseable (terminated) line.
    if (!this.#tailChecked) {
      this.#tailChecked = true;
      await this.#truncateTornTail(path);
    }
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

  /**
   * Truncate an unterminated (torn) final line left by a crash mid-append, so the next append
   * starts on a fresh line. Scans backward from the end for the last `\n`; a missing file or an
   * already-terminated tail is a no-op. Only the WRITER repairs — `read()` stays read-only so a
   * concurrent `runs show` can never mutate a live log.
   */
  async #truncateTornTail(path: string): Promise<void> {
    let handle;
    try {
      handle = await open(path, 'r+');
    } catch {
      return; // No log yet (first append) — nothing to repair.
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return;
      const CHUNK = 4096;
      const buf = Buffer.alloc(CHUNK);
      let end = size;
      while (end > 0) {
        const start = Math.max(0, end - CHUNK);
        const { bytesRead } = await handle.read(buf, 0, end - start, start);
        // First pass only: a terminated tail (last byte `\n`) needs no repair.
        if (end === size && bytesRead > 0 && buf[bytesRead - 1] === 0x0a) return;
        for (let i = bytesRead - 1; i >= 0; i--) {
          if (buf[i] === 0x0a) {
            await handle.truncate(start + i + 1);
            await handle.sync();
            return;
          }
        }
        end = start;
      }
      // No newline anywhere — the whole file is one torn first line.
      await handle.truncate(0);
      await handle.sync();
    } finally {
      await handle.close();
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
    // The write-ahead appender always terminates each COMMITTED line with '\n', leaving a trailing
    // empty element after split. A non-empty trailing element is therefore a TORN tail (a crash cut
    // the append short before its fsync — the state transition never became durable): drop it, so
    // the exact crash the write-ahead log exists for never makes the run unreadable/unresumable.
    // Every terminated line remains untrusted and validated; corruption there still throws.
    // (After a normal write the popped element is the empty string after the final '\n'.)
    if (lines.length > 0) lines.pop();

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
