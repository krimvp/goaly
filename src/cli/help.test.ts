import { describe, it, expect } from 'vitest';
import { documentedFlagNames, helpTopicKeys, renderHelp } from './help';
import { USAGE, USAGE_HEAD, USAGE_TOPICS } from './usage';
import { UsageError } from './flags/tokens';

describe('usage topics', () => {
  it('concatenate to the full USAGE (the flag contract is unchanged by the split)', () => {
    expect(USAGE).toBe([USAGE_HEAD, ...USAGE_TOPICS.map((t) => t.text)].join('\n\n'));
  });

  it('have unique keys and start with a column-0 heading', () => {
    const keys = USAGE_TOPICS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const t of USAGE_TOPICS) {
      expect(t.text.split('\n')[0]).toMatch(/^[^ \t]/);
      expect(t.title.length).toBeGreaterThan(0);
    }
  });
});

describe('renderHelp', () => {
  it('prints a short index by default: the head plus one line per topic', () => {
    const text = renderHelp(undefined);
    expect(text.startsWith(USAGE_HEAD)).toBe(true);
    for (const t of USAGE_TOPICS) expect(text).toContain(`  ${t.key}`);
    expect(text.split('\n').length).toBeLessThan(USAGE.split('\n').length / 4);
  });

  it('prints one section for a topic key, and the whole contract for "all"', () => {
    expect(renderHelp('stuck')).toBe(USAGE_TOPICS.find((t) => t.key === 'stuck')?.text);
    expect(renderHelp('all')).toBe(USAGE);
  });

  it('matches a unique substring of a title, case-insensitively', () => {
    expect(renderHelp('Worktree')).toBe(USAGE_TOPICS.find((t) => t.key === 'worktrees')?.text);
  });

  it('rejects an unknown or ambiguous topic with the topic list', () => {
    expect(() => renderHelp('nonsense')).toThrow(UsageError);
    expect(() => renderHelp('nonsense')).toThrow(/topics: input, /);
  });

  it('lists every topic key plus "all"', () => {
    expect(helpTopicKeys()).toEqual([...USAGE_TOPICS.map((t) => t.key), 'all']);
  });
});

describe('documentedFlagNames', () => {
  it('extracts the flag contract from USAGE, sorted and without the prose globs', () => {
    const names = documentedFlagNames();
    expect(names).toContain('goal');
    expect(names).toContain('max-iterations');
    expect(names).not.toContain('stuck-');
    expect([...names].sort()).toEqual(names);
  });
});
