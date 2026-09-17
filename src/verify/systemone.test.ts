import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { SYSTEMONE_URL, SystemOneVerifier, splitCriteria } from './systemone';
import type { FetchLike } from '../llm-client/openai-client';
import { FakeWorkspace } from '../testing/fakes';
import { GitWorkspace } from '../workspace/git-workspace';

const ws = new FakeWorkspace('abc1234', 'diff --git a/x b/x\n+added line');
const rubric = '- tests cover the new flag\n- the README documents the flag';

type Call = { url: string; body: unknown; auth: string | undefined };

/** A fake transport: records each request and replays the scripted `{status, body}` answers in order. */
function fakeFetch(answers: Array<{ status: number; body: string }>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), auth: init.headers['authorization'] });
    const next = answers.shift() ?? { status: 500, body: 'no scripted answer' };
    return { ok: next.status === 200, status: next.status, text: async () => next.body };
  };
  return { fetch, calls };
}

const answer = (noul: Record<string, number>, model = 'jev-1.13.0'): string =>
  JSON.stringify({
    model,
    answers: Object.fromEntries(Object.entries(noul).map(([k, p]) => [k, { type: 'noul', noul: p }])),
    usage: { input_tokens: 456, output_tokens: 58 },
  });

const verifier = (fetch: FetchLike, apiKey: string | null = 'k'): SystemOneVerifier =>
  new SystemOneVerifier({
    rubric,
    model: 'jev-latest',
    ...(apiKey !== null ? { apiKey } : {}),
    fetch,
    sleep: async () => {},
  });

describe('splitCriteria', () => {
  it('splits on lines and strips bullet / number prefixes; a one-line rubric is one criterion', () => {
    expect(splitCriteria('1. first\n\n* second\n  - third\nfourth')).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ]);
    expect(splitCriteria('all tests pass')).toEqual(['all tests pass']);
  });
});

describe('SystemOneVerifier', () => {
  it('passes when every criterion scores above 0.5; confidence is the minimum', async () => {
    const { fetch, calls } = fakeFetch([{ status: 200, body: answer({ c1: 0.94, c2: 0.71 }) }]);

    const verdict = await verifier(fetch).verify(ws, 'add the flag', 'ignored');

    expect(verdict).toEqual({
      pass: true,
      confidence: 0.71,
      detail:
        'systemone jev-1.13.0, 456 in / 58 out: 0 of 2 criteria fail\n' +
        'ok (p=0.94): tests cover the new flag\n' +
        'ok (p=0.71): the README documents the flag',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(SYSTEMONE_URL);
    expect(calls[0]?.auth).toBe('Bearer k');
    const body = calls[0]?.body as { model: string; state: Record<string, string>; questions: Record<string, { type: string; instructions: string }> };
    expect(body.model).toBe('jev-latest');
    expect(body.state).toEqual({ goal: 'add the flag', rubric, evidence: 'diff --git a/x b/x\n+added line' });
    expect(Object.keys(body.questions)).toEqual(['c1', 'c2']);
    expect(body.questions['c2']?.type).toBe('noul');
    expect(body.questions['c2']?.instructions).toContain('the README documents the flag');
  });

  it('fails when one criterion scores at or below 0.5, naming the failing criterion first', async () => {
    const { fetch } = fakeFetch([{ status: 200, body: answer({ c1: 0.9, c2: 0.12 }) }]);

    const verdict = await verifier(fetch).verify(ws, 'g', 'r');

    expect(verdict.pass).toBe(false);
    expect(verdict.confidence).toBe(0.12);
    expect(verdict.evaluable).toBeUndefined();
    expect(verdict.detail.split('\n')).toEqual([
      'systemone jev-1.13.0, 456 in / 58 out: 1 of 2 criteria fail',
      'FAIL (p=0.12): the README documents the flag',
      'ok (p=0.90): tests cover the new flag',
    ]);
  });

  it('is unevaluable without a key, and never calls the endpoint', async () => {
    const { fetch, calls } = fakeFetch([]);

    const verdict = await verifier(fetch, null).verify(ws, 'g', 'r');

    expect(verdict).toEqual({
      pass: false,
      confidence: 0,
      detail: 'systemone could not evaluate: TYPESAFE_API_KEY is not set',
      evaluable: false,
    });
    expect(calls).toEqual([]);
  });

  it.each([
    ['an HTTP error', { status: 401, body: 'bad key' }, 'HTTP 401: bad key'],
    ['a non-JSON body', { status: 200, body: 'not json' }, 'Unexpected token'],
    ['a schema mismatch', { status: 200, body: '{"answers":{}}' }, 'malformed answer'],
    ['a missing criterion', { status: 200, body: answer({ c1: 0.9 }) }, 'no answer for criterion 2'],
  ])('a fault (%s) is a fail-closed could-not-evaluate red, never a throw', async (_name, reply, reason) => {
    const { fetch } = fakeFetch([reply]);

    const verdict = await verifier(fetch).verify(ws, 'g', 'r');

    expect(verdict.pass).toBe(false);
    expect(verdict.confidence).toBe(0);
    expect(verdict.evaluable).toBe(false);
    expect(verdict.detail).toContain(reason);
  });

  it('a thrown fetch (timeout / network) is unevaluable', async () => {
    const fetch: FetchLike = async () => {
      throw new Error('aborted');
    };

    const verdict = await verifier(fetch).verify(ws, 'g', 'r');

    expect(verdict.evaluable).toBe(false);
    expect(verdict.detail).toBe('systemone could not evaluate: aborted');
  });

  it('retries once on 429 / 529, then gives up', async () => {
    const ok = fakeFetch([{ status: 429, body: 'slow down' }, { status: 200, body: answer({ c1: 0.8, c2: 0.9 }) }]);
    expect((await verifier(ok.fetch).verify(ws, 'g', 'r')).pass).toBe(true);
    expect(ok.calls).toHaveLength(2);

    const twice = fakeFetch([{ status: 529, body: 'busy' }, { status: 529, body: 'busy' }]);
    const verdict = await verifier(twice.fetch).verify(ws, 'g', 'r');
    expect(verdict.evaluable).toBe(false);
    expect(verdict.detail).toContain('HTTP 529');
    expect(twice.calls).toHaveLength(2);
  });

  it('caps the evidence it sends', async () => {
    const big = new FakeWorkspace('abc1234', 'x'.repeat(20_000));
    const { fetch, calls } = fakeFetch([{ status: 200, body: answer({ c1: 0.8, c2: 0.9 }) }]);

    await verifier(fetch).verify(big, 'g', 'r');

    const body = calls[0]?.body as { state: { evidence: string } };
    expect(body.state.evidence).toHaveLength(8000);
  });
});

/** Live call against the real endpoint: GOALY_LIVE=1 TYPESAFE_API_KEY=… npx vitest run src/verify/systemone.test.ts */
const live = process.env['GOALY_LIVE'] === '1' && process.env['TYPESAFE_API_KEY'] !== undefined;
describe.skipIf(!live)('SystemOneVerifier (live)', () => {
  it('grades a real diff: one criterion met, one not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'goaly-systemone-live-'));
    try {
      await writeFile(join(root, 'README'), 'live\n');
      for (const args of [
        ['init', '-q'],
        ['config', 'user.email', 't@e.com'],
        ['config', 'user.name', 'T'],
        ['add', '-A'],
        ['commit', '-q', '-m', 'initial'],
      ]) {
        spawnSync('git', args, { cwd: root });
      }
      await writeFile(join(root, 'hello.py'), 'def greet(name):\n    return "Hello, " + name\n');
      const verdict = await new SystemOneVerifier({
        rubric: '- hello.py defines a function named greet\n- the function greet has a docstring',
        model: 'jev-latest',
        apiKey: process.env['TYPESAFE_API_KEY']!,
      }).verify(new GitWorkspace(root), 'add a greet function with a docstring', '');

      process.stdout.write(`${verdict.detail}\n`);
      expect(verdict.pass).toBe(false);
      expect(verdict.evaluable).toBeUndefined();
      expect(verdict.detail.split('\n')[1]).toMatch(/^FAIL \(p=0\.\d\d\): the function greet has a docstring$/);
      expect(verdict.detail.split('\n')[2]).toMatch(/^ok \(p=0\.\d\d\): hello\.py defines a function named greet$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
