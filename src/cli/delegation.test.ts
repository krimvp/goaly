import { describe, it, expect } from 'vitest';
import { DEFAULT_DELEGATION_CANDIDATES, parseDelegationDirective } from './delegation';

describe('parseDelegationDirective — natural-language parallel delegation', () => {
  describe('counted subagent directives (verb required)', () => {
    it('"work with N subagents" parses and strips cleanly', () => {
      const d = parseDelegationDirective('fix the flaky auth test, work with 4 subagents');
      expect(d).not.toBeNull();
      expect(d!.candidates).toBe(4);
      expect(d!.cleaned).toBe('fix the flaky auth test');
    });

    it('a leading directive strips its dangling connector ("use N subagents to …")', () => {
      const d = parseDelegationDirective('use 4 subagents to fix the flaky auth test');
      expect(d!.candidates).toBe(4);
      expect(d!.cleaned).toBe('fix the flaky auth test');
    });

    it('hyphenated "sub-agents" and other verbs parse too', () => {
      expect(parseDelegationDirective('fix it, delegate to 2 sub-agents')!.candidates).toBe(2);
      expect(parseDelegationDirective('fix it, spawn 5 subagents')!.candidates).toBe(5);
      expect(parseDelegationDirective('fix it using 3 concurrent subagents')!.candidates).toBe(3);
    });

    it('a mid-sentence directive keeps the surrounding goal intact', () => {
      const d = parseDelegationDirective('use 3 subagents and make the linter pass');
      expect(d!.candidates).toBe(3);
      expect(d!.cleaned).toBe('make the linter pass');
    });

    it('a sentence-final directive keeps the terminator', () => {
      const d = parseDelegationDirective('Make the linter pass, use 3 subagents.');
      expect(d!.candidates).toBe(3);
      expect(d!.cleaned).toBe('Make the linter pass.');
    });
  });

  describe('parallel-attempt directives', () => {
    it('"N parallel attempts" parses with or without a verb', () => {
      expect(parseDelegationDirective('fix the parser with 3 parallel attempts')!.candidates).toBe(3);
      expect(parseDelegationDirective('fix the parser, 2 parallel attempts')!.candidates).toBe(2);
      expect(parseDelegationDirective('make 4 parallel attempts at fixing the parser')!.candidates).toBe(4);
    });

    it('"N parallel candidates/tries" parse too', () => {
      expect(parseDelegationDirective('fix it, run 4 parallel candidates')!.candidates).toBe(4);
      expect(parseDelegationDirective('fix it with 2 parallel tries')!.candidates).toBe(2);
    });
  });

  describe('uncounted subagent directives (documented default)', () => {
    it('"use subagents" defaults the count', () => {
      const d = parseDelegationDirective('fix the flaky test, use subagents');
      expect(d!.candidates).toBe(DEFAULT_DELEGATION_CANDIDATES);
      expect(d!.cleaned).toBe('fix the flaky test');
    });

    it('"spawn several subagents" defaults the count', () => {
      expect(parseDelegationDirective('spawn several subagents to fix the test')!.candidates).toBe(
        DEFAULT_DELEGATION_CANDIDATES,
      );
    });
  });

  describe('false-positive guard — application-domain goals never trigger', () => {
    it.each([
      'make the tests run in parallel',
      'implement a job queue with 4 parallel workers',
      'add retry logic with 3 attempts',
      'handle 5 parallel login attempts without racing',
      'document the 3 subagents in the README', // subagents as a domain noun, no delegation verb
      'implement a worker pool with 8 threads',
      'parallelize the build across CI shards',
    ])('%s', (goal) => {
      expect(parseDelegationDirective(goal)).toBeNull();
    });

    it('a zero count is not a directive', () => {
      expect(parseDelegationDirective('use 0 subagents to fix it')).toBeNull();
    });
  });

  it('the matched phrase is surfaced for the interpretation log', () => {
    const d = parseDelegationDirective('fix the test, work with 4 subagents');
    expect(d!.phrase).toContain('work with 4 subagents');
  });

  it('only the FIRST directive is consumed', () => {
    const d = parseDelegationDirective('use 4 subagents, then use 2 subagents');
    expect(d!.candidates).toBe(4);
  });

  it('a goal that is ONLY a directive cleans to the empty string (caller fails closed)', () => {
    expect(parseDelegationDirective('use 4 subagents')!.cleaned).toBe('');
  });
});
