import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeDeps } from './compose';
import { drive } from '../driver/driver';
import { makeConfig } from '../testing/fakes';
import { FakeLlm } from '../llm/provider';
import { asRunId } from '../domain/ids';
import { runProcess } from '../util/spawn';
import type { FetchLike } from '../llm-client/openai-client';

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'goaly-sdk-e2e-'));
  await runProcess('git', ['-C', dir, 'init', '-q']);
  await runProcess('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  await runProcess('git', ['-C', dir, 'config', 'user.name', 'tester']);
  await writeFile(path.join(dir, 'README.md'), '# fixture\n');
  await runProcess('git', ['-C', dir, 'add', '-A']);
  await runProcess('git', ['-C', dir, 'commit', '-qm', 'init']);
  return dir;
}

/** A fake chat-completions endpoint: turn 1 writes a file via a tool call, turn 2 finishes. */
function scriptedEndpoint(): FetchLike {
  let call = 0;
  const reply = (body: unknown) =>
    Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) });
  return () => {
    call += 1;
    const usage = { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 };
    if (call === 1) {
      return reply({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'write_file', arguments: JSON.stringify({ path: 'made.txt', content: 'hello' }) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage,
      });
    }
    return reply({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'c2', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary: 'created made.txt' }) } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage,
    });
  };
}

describe('goaly-code harness — full pipeline end-to-end (real git + fs, fake HTTP endpoint)', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('runs goaly\'s own loop, edits the tree, and reaches a verified DONE', async () => {
    dir = await initRepo();
    const config = makeConfig({
      goal: 'create made.txt',
      verifier: { kind: 'existing', ref: 'test -f made.txt' },
      autonomous: true,
    });
    const runId = asRunId('run-sdk-e2e');
    const deps = composeDeps(config, {
      harness: 'goaly-code',
      baseUrl: 'https://fake.endpoint/v1',
      llmApiKey: 'sk-fake',
      llmFetch: scriptedEndpoint(),
      models: { model: 'fake-model' },
      workspaceRoot: dir,
      runId,
      noLogConsole: true,
      // The Sign-off approver is an LLM step — short-circuit it with a fake (the HARNESS still uses
      // the OpenAI client above). It does not veto.
      llm: new FakeLlm(['{"veto": false}']),
    });

    const outcome = await drive(deps, config, runId);

    expect(outcome.status).toBe('DONE');
    expect(outcome.iterations).toBe(1);
    // The agent actually wrote the file through the path-guarded host (real fs).
    expect(await readFile(path.join(dir, 'made.txt'), 'utf8')).toBe('hello');
    // Reported token usage from the endpoint's `usage` blocks flowed into the spend report.
    expect(outcome.usage?.harness.tokens).toBeGreaterThan(0);
  });
});
