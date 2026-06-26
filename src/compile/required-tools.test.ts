import { describe, it, expect } from 'vitest';
import { extractRequiredTools, isProbeSafe } from './required-tools';

describe('extractRequiredTools', () => {
  it('pulls the leading program from each && / ; / | segment', () => {
    expect(extractRequiredTools(['cargo fmt --all -- --check && cargo clippy && cargo test'])).toEqual([
      'cargo',
    ]);
    expect(extractRequiredTools(['python -m pytest -q'])).toEqual(['python']);
    expect(extractRequiredTools(['npm run build && node smoke.mjs'])).toEqual(['npm', 'node']);
  });

  it('dedupes across all commands, first-seen order', () => {
    expect(extractRequiredTools(['cargo test', 'cargo clippy', 'rustup show'])).toEqual([
      'cargo',
      'rustup',
    ]);
  });

  it('skips leading FOO=bar env assignments', () => {
    expect(extractRequiredTools(['RUST_LOG=debug cargo test'])).toEqual(['cargo']);
  });

  it('drops ubiquitous builtins / coreutils (cosmetic — the probe would find them anyway)', () => {
    expect(extractRequiredTools(['true'])).toEqual([]);
    expect(extractRequiredTools(['echo hi && cat f'])).toEqual([]);
  });

  it('under-reports rather than guessing: skips subshells, scripts, paths, and pipes-into', () => {
    expect(extractRequiredTools(['$(which pytest) -q'])).toEqual([]);
    expect(extractRequiredTools(['./run.sh'])).toEqual([]);
    expect(extractRequiredTools(['/usr/bin/make all'])).toEqual([]);
  });

  it('returns [] for a tool-less bar', () => {
    expect(extractRequiredTools([])).toEqual([]);
    expect(extractRequiredTools(['true', ': noop'])).toEqual([]);
  });

  it('handles real program names with dots/plus/hyphen', () => {
    expect(extractRequiredTools(['python3.12 -V', 'g++ --version', 'golangci-lint run'])).toEqual([
      'python3.12',
      'g++',
      'golangci-lint',
    ]);
  });
});

describe('isProbeSafe', () => {
  it('accepts plain program names', () => {
    for (const t of ['cargo', 'python3', 'g++', 'golangci-lint', 'go.tool']) {
      expect(isProbeSafe(t)).toBe(true);
    }
  });

  it('rejects names carrying shell metacharacters (injection guard)', () => {
    for (const t of ['cargo; rm -rf /', 'a b', '$(x)', '`x`', 'foo|bar', '../x', '']) {
      expect(isProbeSafe(t)).toBe(false);
    }
  });
});
