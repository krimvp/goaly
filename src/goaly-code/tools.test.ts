import { describe, it, expect } from 'vitest';
import { DEFAULT_TOOLS, dispatchTool, toApiTools, type ToolHost } from './tools';

class FakeHost implements ToolHost {
  readonly calls: Array<{ tool: string; args: unknown[] }> = [];
  async readFile(p: string, range?: unknown): Promise<string> {
    this.calls.push({ tool: 'readFile', args: [p, range] });
    return 'CONTENT';
  }
  async listDir(p: string): Promise<string> {
    this.calls.push({ tool: 'listDir', args: [p] });
    return 'LIST';
  }
  async grep(pattern: string, p: string | undefined): Promise<string> {
    this.calls.push({ tool: 'grep', args: [pattern, p] });
    return 'GREP';
  }
  async writeFile(p: string, content: string): Promise<string> {
    this.calls.push({ tool: 'writeFile', args: [p, content] });
    return 'WROTE';
  }
  async editFile(p: string, o: string, n: string): Promise<string> {
    this.calls.push({ tool: 'editFile', args: [p, o, n] });
    return 'EDITED';
  }
  async runShell(command: string): Promise<string> {
    this.calls.push({ tool: 'runShell', args: [command] });
    return 'SHELL';
  }
}

describe('dispatchTool (fail-closed, never throws — §2.3)', () => {
  it('returns an error string for an unknown tool', async () => {
    const r = await dispatchTool(DEFAULT_TOOLS, 'nope', '{}', new FakeHost());
    expect(r).toEqual({ output: 'Error: unknown tool "nope"', terminal: false });
  });

  it('returns an error string for non-JSON arguments', async () => {
    const r = await dispatchTool(DEFAULT_TOOLS, 'read_file', '{bad', new FakeHost());
    expect(r.output).toMatch(/not valid JSON/);
    expect(r.terminal).toBe(false);
  });

  it('returns an error string for arguments that fail validation', async () => {
    const r = await dispatchTool(DEFAULT_TOOLS, 'read_file', '{}', new FakeHost()); // missing path
    expect(r.output).toMatch(/^Error:/);
    expect(r.terminal).toBe(false);
  });

  it('treats empty arguments as {} (so list_dir defaults path to ".")', async () => {
    const host = new FakeHost();
    const r = await dispatchTool(DEFAULT_TOOLS, 'list_dir', '', host);
    expect(r.output).toBe('LIST');
    expect(host.calls[0]).toEqual({ tool: 'listDir', args: ['.'] });
  });

  it('marks finish as terminal and returns the summary', async () => {
    const r = await dispatchTool(DEFAULT_TOOLS, 'finish', '{"summary":"did the thing"}', new FakeHost());
    expect(r).toEqual({ output: 'did the thing', terminal: true });
  });
});

describe('individual tools map args to host calls', () => {
  it('read_file passes an optional line range', async () => {
    const host = new FakeHost();
    await dispatchTool(DEFAULT_TOOLS, 'read_file', '{"path":"a.ts","start_line":2,"end_line":9}', host);
    expect(host.calls[0]).toEqual({ tool: 'readFile', args: ['a.ts', { startLine: 2, endLine: 9 }] });
  });

  it('read_file omits the range when no lines are given', async () => {
    const host = new FakeHost();
    await dispatchTool(DEFAULT_TOOLS, 'read_file', '{"path":"a.ts"}', host);
    expect(host.calls[0]).toEqual({ tool: 'readFile', args: ['a.ts', undefined] });
  });

  it('grep passes pattern and optional path', async () => {
    const host = new FakeHost();
    await dispatchTool(DEFAULT_TOOLS, 'grep', '{"pattern":"foo","path":"src"}', host);
    expect(host.calls[0]).toEqual({ tool: 'grep', args: ['foo', 'src'] });
  });

  it('write_file passes path and content', async () => {
    const host = new FakeHost();
    await dispatchTool(DEFAULT_TOOLS, 'write_file', '{"path":"a.ts","content":"x"}', host);
    expect(host.calls[0]).toEqual({ tool: 'writeFile', args: ['a.ts', 'x'] });
  });

  it('edit_file passes old/new strings', async () => {
    const host = new FakeHost();
    await dispatchTool(DEFAULT_TOOLS, 'edit_file', '{"path":"a","old_string":"o","new_string":"n"}', host);
    expect(host.calls[0]).toEqual({ tool: 'editFile', args: ['a', 'o', 'n'] });
  });

  it('run_shell passes the command', async () => {
    const host = new FakeHost();
    await dispatchTool(DEFAULT_TOOLS, 'run_shell', '{"command":"ls -la"}', host);
    expect(host.calls[0]).toEqual({ tool: 'runShell', args: ['ls -la'] });
  });
});

describe('toApiTools', () => {
  it('exposes every default tool as an OpenAI function with a JSON-Schema parameters object', () => {
    const api = toApiTools(DEFAULT_TOOLS);
    expect(api.map((t) => t.function.name)).toEqual([
      'read_file',
      'list_dir',
      'grep',
      'write_file',
      'edit_file',
      'run_shell',
      'finish',
    ]);
    for (const t of api) {
      expect(t.type).toBe('function');
      expect(t.function.parameters['type']).toBe('object');
    }
  });
});
