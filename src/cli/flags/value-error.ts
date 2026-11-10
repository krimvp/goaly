import type { z } from 'zod';
import { UsageError } from './tokens';

/** The one shape of a bad flag value: the flag, what it accepts, and the value given. */
export function badFlagValue(flag: string, expected: string, value: unknown): UsageError {
  return new UsageError(`${flag}: expected ${expected}, got '${String(value)}'`, flag);
}

/** What a failed Zod issue accepts, in the words of {@link badFlagValue}. */
export function zodExpectation(issue: z.ZodIssue | undefined): string {
  switch (issue?.code) {
    case 'invalid_type':
      if (issue.expected === 'integer') return 'an integer';
      return issue.expected === 'number' ? 'a number' : `a ${issue.expected}`;
    case 'invalid_enum_value':
      return issue.options.join(' | ');
    case 'too_small':
      if (issue.type === 'number') return `a number ${issue.inclusive ? '≥' : '>'} ${String(issue.minimum)}`;
      return issue.minimum === 1 ? 'a non-empty value' : `at least ${String(issue.minimum)} ${unit(issue.type)}`;
    case 'too_big':
      if (issue.type === 'number') return `a number ${issue.inclusive ? '≤' : '<'} ${String(issue.maximum)}`;
      return `at most ${String(issue.maximum)} ${unit(issue.type)}`;
    default:
      return `a valid value (${issue?.message ?? 'invalid'})`;
  }
}

const unit = (type: string): string => (type === 'array' || type === 'set' ? 'entries' : 'characters');
