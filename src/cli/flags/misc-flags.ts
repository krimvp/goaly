import { LogLevel } from '../../log/logger';
import { UsageError } from './tokens';

/** Validate --log-level at the seam (fails closed on an unknown level). Default `info`. */
export function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) return 'info';
  const parsed = LogLevel.safeParse(value);
  if (!parsed.success) {
    throw new UsageError(`unknown log level: ${value} (expected debug | info | warn | error)`);
  }
  return parsed.data;
}

export function parseWorkspaceMode(value: string | undefined): 'git' | 'file' | 'auto' {
  if (value === undefined) return 'auto';
  if (value !== 'git' && value !== 'file' && value !== 'auto') {
    throw new UsageError(`--workspace-mode must be git|file|auto (got "${value}")`);
  }
  return value;
}
