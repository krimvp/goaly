/**
 * Session persistence for the goaly-code harness (spec §2.2, invariant #7). The harness owns its own
 * conversation history; the orchestrator only threads a {@link SessionId} across iterations, so to
 * resume a run we must reload the prior message log keyed by that id and append the next prompt.
 *
 * It is fail-closed on READ (a corrupt/missing/unparseable file degrades to `null` — a fresh session,
 * logged loudly by the caller — never a throw) and validates every message with the same Zod schema
 * the wire uses (invariant #6). The id is sanitized into a filename before it touches the disk, so a
 * hostile session id can never escape the session directory (defense-in-depth at the seam).
 */

import { readFile, mkdir, open, rename } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { SessionId } from '../domain/ids';
import { ChatMessage } from '../llm-client/schema';

export interface SessionStore {
  /** Load the prior message log for `id`, or `null` when absent/corrupt (degrade to fresh). */
  load(id: SessionId): Promise<ChatMessage[] | null>;
  /** Persist the full message log for `id` (write-ahead before the harness returns). */
  save(id: SessionId, messages: ChatMessage[]): Promise<void>;
}

const MessageLog = z.array(ChatMessage);

/** Minimal filesystem seam so the store is unit-testable without touching disk. */
export interface SessionFs {
  readFile(file: string): Promise<string>;
  writeFile(file: string, data: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
}

const nodeSessionFs: SessionFs = {
  readFile: (file) => readFile(file, 'utf8'),
  // ATOMIC save (tmp → fsync → rename): `save()` rewrites the WHOLE message log every turn, so a
  // plain in-place write torn by a crash would truncate the file — and the fail-closed `load()`
  // would then silently degrade the ENTIRE conversation to a fresh session (losing every turn, not
  // just the last). With rename-in-place the previous complete log survives any crash mid-save.
  writeFile: async (file, data) => {
    const tmp = `${file}.tmp-${process.pid}`;
    const handle = await open(tmp, 'w');
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  },
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
};

/** Sanitize a session id into a safe single path component (no separators, no leading dot). */
export function sessionFileName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_');
  return `${safe.length > 0 ? safe : 'session'}.json`;
}

export class FileSessionStore implements SessionStore {
  readonly #dir: string;
  readonly #fs: SessionFs;

  constructor(opts: { dir: string; fs?: SessionFs }) {
    this.#dir = opts.dir;
    this.#fs = opts.fs ?? nodeSessionFs;
  }

  #file(id: SessionId): string {
    return path.join(this.#dir, sessionFileName(id));
  }

  async load(id: SessionId): Promise<ChatMessage[] | null> {
    let raw: string;
    try {
      raw = await this.#fs.readFile(this.#file(id));
    } catch {
      return null; // missing file → fresh session
    }
    try {
      const parsed = MessageLog.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null; // corrupt → fresh session
    } catch {
      return null;
    }
  }

  async save(id: SessionId, messages: ChatMessage[]): Promise<void> {
    await this.#fs.mkdir(this.#dir);
    await this.#fs.writeFile(this.#file(id), JSON.stringify(messages));
  }
}

/** In-memory store for tests / embedders that don't need cross-process resume. */
export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<string, ChatMessage[]>();
  async load(id: SessionId): Promise<ChatMessage[] | null> {
    const found = this.#sessions.get(id);
    return found ? [...found] : null;
  }
  async save(id: SessionId, messages: ChatMessage[]): Promise<void> {
    this.#sessions.set(id, [...messages]);
  }
}
