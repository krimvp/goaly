import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CompiledContract } from '../domain/contract';

/**
 * The language / test-runner context a defect record carries, and how it is DERIVED — never
 * supplied. Both sides are deterministic probes:
 *
 *  - the WRITE side reads the FROZEN contract (its commands, required tools, authored file
 *    extensions) — goaly's own artifact, not the worker's;
 *  - the READ side probes the workspace's manifests on disk (the same fail-soft style as
 *    `workspace-facts.ts`), so the compiler is only ever shown patterns from a matching ecosystem.
 *
 * They are ENUMS, not strings, for a structural reason: an enum is a closed vocabulary, so no
 * repo text, worker output, or model prose can ride into a record through the context fields.
 */

export const DEFECT_LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'go',
  'rust',
  'ruby',
  'java',
  'unknown',
] as const;
export const DefectLanguage = z.enum(DEFECT_LANGUAGES);
export type DefectLanguage = z.infer<typeof DefectLanguage>;

export const DEFECT_RUNNERS = [
  'vitest',
  'jest',
  'mocha',
  'pytest',
  'unittest',
  'go-test',
  'cargo-test',
  'rspec',
  'junit',
  'make',
  'unknown',
] as const;
export const DefectRunner = z.enum(DEFECT_RUNNERS);
export type DefectRunner = z.infer<typeof DefectRunner>;

/** One record's context (write side): a single best-effort language + runner. */
export type DefectContext = { readonly language: DefectLanguage; readonly runner: DefectRunner };

/** The workspace's context (read side): every ecosystem detected, for relevance filtering. */
export type WorkspaceDefectContext = {
  readonly languages: readonly DefectLanguage[];
  readonly runners: readonly DefectRunner[];
};

const RUNNER_PATTERNS: readonly (readonly [RegExp, DefectRunner])[] = [
  [/\bvitest\b/, 'vitest'],
  [/\bjest\b/, 'jest'],
  [/\bmocha\b/, 'mocha'],
  [/\bpytest\b/, 'pytest'],
  [/\bunittest\b/, 'unittest'],
  [/\bgo\s+test\b/, 'go-test'],
  [/\bcargo\s+test\b/, 'cargo-test'],
  [/\brspec\b/, 'rspec'],
  [/\bjunit\b|\bmvn\b|\bgradle\b/, 'junit'],
  [/\bmake\b/, 'make'],
];

/** Which language a runner implies, when nothing more specific was found. */
const RUNNER_LANGUAGE: Partial<Record<DefectRunner, DefectLanguage>> = {
  vitest: 'javascript',
  jest: 'javascript',
  mocha: 'javascript',
  pytest: 'python',
  unittest: 'python',
  'go-test': 'go',
  'cargo-test': 'rust',
  rspec: 'ruby',
  junit: 'java',
};

const TOOL_LANGUAGE: readonly (readonly [RegExp, DefectLanguage])[] = [
  [/^(node|npm|npx|pnpm|yarn|bun)$/, 'javascript'],
  [/^(tsc|ts-node|tsx)$/, 'typescript'],
  [/^(python3?|pip3?|pytest|uv)$/, 'python'],
  [/^go$/, 'go'],
  [/^(cargo|rustc)$/, 'rust'],
  [/^(ruby|bundle|rspec)$/, 'ruby'],
  [/^(java|javac|mvn|gradle)$/, 'java'],
];

const EXTENSION_LANGUAGE: Readonly<Record<string, DefectLanguage>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.java': 'java',
};

function matchRunner(text: string): DefectRunner {
  for (const [re, runner] of RUNNER_PATTERNS) {
    if (re.test(text)) return runner;
  }
  return 'unknown';
}

/**
 * Derive the context of a record from the FROZEN contract: its deterministic rung commands, its
 * setup, its required-tools manifest, and the extensions of the files the compiler authored. All
 * of it is goaly's own text — the worker never wrote a byte of it.
 */
export function contractDefectContext(contract: CompiledContract): DefectContext {
  const commands = contract.rungs
    .map((rung) => (rung.kind === 'deterministic' ? rung.command : ''))
    .join(' ');
  const haystack = [commands, contract.setup ?? '', contract.requiredTools.join(' ')]
    .join(' ')
    .toLowerCase();
  const runner = matchRunner(haystack);

  for (const file of contract.generatedFiles) {
    const language = EXTENSION_LANGUAGE[path.extname(file.path).toLowerCase()];
    if (language !== undefined) return { language, runner };
  }
  for (const tool of contract.requiredTools) {
    const hit = TOOL_LANGUAGE.find(([re]) => re.test(tool.trim().toLowerCase()));
    if (hit !== undefined) return { language: hit[1], runner };
  }
  return { language: RUNNER_LANGUAGE[runner] ?? 'unknown', runner };
}

/** Read a file, or `undefined` — every probe below is fail-soft (a probe never throws). */
function readIfPresent(root: string, rel: string): string | undefined {
  const full = path.join(root, rel);
  if (!existsSync(full)) return undefined;
  try {
    return readFileSync(full, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Probe the workspace for the ecosystems in play, so a corpus entry from another language is not
 * injected into this run's authoring prompt. Fail-soft throughout: an unreadable manifest simply
 * contributes nothing, and a workspace with no recognizable manifest returns empty lists (which
 * the selector reads as "no filter" — everything is potentially relevant).
 */
export function workspaceDefectContext(root: string): WorkspaceDefectContext {
  const languages = new Set<DefectLanguage>();
  const runners = new Set<DefectRunner>();

  const pkg = readIfPresent(root, 'package.json');
  if (pkg !== undefined) {
    languages.add('javascript');
    if (existsSync(path.join(root, 'tsconfig.json'))) languages.add('typescript');
    const runner = matchRunner(pkg.toLowerCase());
    if (runner !== 'unknown') runners.add(runner);
  }
  const python =
    readIfPresent(root, 'pyproject.toml') ??
    readIfPresent(root, 'requirements.txt') ??
    readIfPresent(root, 'setup.py');
  if (python !== undefined) {
    languages.add('python');
    runners.add(/pytest/i.test(python) ? 'pytest' : 'unittest');
  }
  if (existsSync(path.join(root, 'go.mod'))) {
    languages.add('go');
    runners.add('go-test');
  }
  if (existsSync(path.join(root, 'Cargo.toml'))) {
    languages.add('rust');
    runners.add('cargo-test');
  }
  const gemfile = readIfPresent(root, 'Gemfile');
  if (gemfile !== undefined) {
    languages.add('ruby');
    if (/rspec/i.test(gemfile)) runners.add('rspec');
  }
  if (
    existsSync(path.join(root, 'pom.xml')) ||
    existsSync(path.join(root, 'build.gradle')) ||
    existsSync(path.join(root, 'build.gradle.kts'))
  ) {
    languages.add('java');
    runners.add('junit');
  }
  if (existsSync(path.join(root, 'Makefile'))) runners.add('make');

  return { languages: [...languages], runners: [...runners] };
}
