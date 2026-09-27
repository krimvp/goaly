import { describe, expect, it } from 'vitest';
import { promptForGoal } from './interactive';

describe('promptForGoal', () => {
  it('asks once and returns a trimmed goal', async () => {
    const prompts: string[] = [];
    const goal = await promptForGoal(async (prompt) => {
      prompts.push(prompt);
      return '  Fix the login flow  ';
    });

    expect(goal).toBe('Fix the login flow');
    expect(prompts).toEqual(['What should goaly work on? ']);
  });

  it('returns undefined for an empty answer', async () => {
    await expect(promptForGoal(async () => '  ')).resolves.toBeUndefined();
  });

  it('returns undefined when input closes or the user interrupts', async () => {
    const closed = Object.assign(new Error('closed'), { code: 'ERR_USE_AFTER_CLOSE' });
    await expect(promptForGoal(async () => Promise.reject(closed))).resolves.toBeUndefined();
    const interrupted = Object.assign(new Error('interrupted'), { name: 'AbortError' });
    await expect(promptForGoal(async () => Promise.reject(interrupted))).resolves.toBeUndefined();
  });

  it('reports an unexpected input error', async () => {
    await expect(promptForGoal(async () => Promise.reject(new Error('input failed')))).rejects.toThrow('input failed');
  });
});
