import type { z } from 'zod';
import { UsageError } from './tokens';

/** The one shape of a bad flag value: the flag, what it accepts, and the value given. */
export function badFlagValue(flag: string, expected: string, value: unknown): UsageError {
  return new UsageError(`${flag}: expected ${expected}, got '${String(value)}'`, flag);
}

/** What a failed Zod issue accepts, in the words of {@link badFlagValue}. */
export function zodExpectation(issue: z.core.$ZodIssue | undefined): string {
  switch (issue?.code) {
    case 'invalid_type':
      if (issue.expected === 'int') return 'an integer';
      return `a ${issue.expected}`;
    case 'invalid_value':
      return issue.values.map(String).join(' | ');
    case 'too_small':
      if (issue.origin === 'number' || issue.origin === 'int') {
        return `a number ${issue.inclusive === true ? '≥' : '>'} ${String(issue.minimum)}`;
      }
      return issue.minimum === 1 ? 'a non-empty value' : `at least ${String(issue.minimum)} ${unit(issue.origin)}`;
    case 'too_big':
      if (issue.origin === 'number' || issue.origin === 'int') {
        return `a number ${issue.inclusive === true ? '≤' : '<'} ${String(issue.maximum)}`;
      }
      return `at most ${String(issue.maximum)} ${unit(issue.origin)}`;
    default:
      return `a valid value (${issue?.message ?? 'invalid'})`;
  }
}

const unit = (type: string): string => (type === 'array' || type === 'set' ? 'entries' : 'characters');
