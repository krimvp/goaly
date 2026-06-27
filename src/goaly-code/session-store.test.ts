import { describe, it, expect } from 'vitest';
import { FileSessionStore, InMemorySessionStore, sessionFileName, type SessionFs } from './session-store';
import { SessionId } from '../domain/ids';
import type { ChatMessage } from '../llm-client/schema';

class FakeFs implements SessionFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  async readFile(file: string): Promise<string> {
    const f = this.files.get(file);
    if (f === undefined) throw new Error('ENOENT');
    return f;
  }
  async writeFile(file: string, data: string): Promise<void> {
    this.files.set(file, data);
  }
  async mkdir(dir: string): Promise<void> {
    this.dirs.add(dir);
  }
}

const id = (s: string): SessionId => SessionId.parse(s);
const log: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'hi' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'finish', arguments: '{}' } }] },
  { role: 'tool', content: 'done', tool_call_id: 'c1' },
];

describe('sessionFileName', () => {
  it('sanitizes path separators and other unsafe chars', () => {
    expect(sessionFileName('a/b:c')).toBe('a_b_c.json');
  });
  it('strips leading dots so the file is never hidden / traversal', () => {
    expect(sessionFileName('../x')).toBe('__x.json');
  });
});

describe('FileSessionStore', () => {
  it('round-trips a message log through save/load', async () => {
    const fs = new FakeFs();
    const store = new FileSessionStore({ dir: '/state/sessions', fs });
    await store.save(id('sdk-1'), log);
    expect(fs.dirs.has('/state/sessions')).toBe(true);
    const loaded = await store.load(id('sdk-1'));
    expect(loaded).toEqual(log);
  });

  it('returns null for a missing session (fresh)', async () => {
    const store = new FileSessionStore({ dir: '/state', fs: new FakeFs() });
    expect(await store.load(id('sdk-missing'))).toBeNull();
  });

  it('returns null for corrupt JSON (fail-closed → fresh)', async () => {
    const fs = new FakeFs();
    fs.files.set('/state/sdk-1.json', 'not json <<<');
    const store = new FileSessionStore({ dir: '/state', fs });
    expect(await store.load(id('sdk-1'))).toBeNull();
  });

  it('returns null for a schema-invalid log (fail-closed → fresh)', async () => {
    const fs = new FakeFs();
    fs.files.set('/state/sdk-1.json', JSON.stringify([{ role: 'wizard', content: 'x' }]));
    const store = new FileSessionStore({ dir: '/state', fs });
    expect(await store.load(id('sdk-1'))).toBeNull();
  });

  it('writes under a sanitized filename', async () => {
    const fs = new FakeFs();
    const store = new FileSessionStore({ dir: '/state', fs });
    await store.save(id('sdk-a/b'), log);
    expect([...fs.files.keys()][0]).toBe('/state/sdk-a_b.json');
  });
});

describe('InMemorySessionStore', () => {
  it('round-trips and returns isolated copies', async () => {
    const store = new InMemorySessionStore();
    expect(await store.load(id('x'))).toBeNull();
    await store.save(id('x'), log);
    const a = await store.load(id('x'));
    expect(a).toEqual(log);
    a!.push({ role: 'user', content: 'mutate' });
    expect(await store.load(id('x'))).toEqual(log); // stored copy unaffected
  });
});
