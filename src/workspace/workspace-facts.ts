import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Deterministic, generic-safe facts about the workspace, probed from files on disk at compose time
 * and injected into the AUTHORING prompts (compiler + contract red-team). Small models fail the bar
 * on mechanical environment mismatches they never went looking for — the observed one: authoring a
 * CommonJS `require()` verify file into a `"type": "module"` package, which crashes at load and
 * kills the run at pre-flight. Stating the detected facts in the prompt closes that gap for free.
 *
 * goaly is NOT code-only: a goal may be prose, data, config, anything in a git tree. So facts are
 * strictly DETECTED, never assumed — nothing is emitted for a workspace with no recognized
 * manifests (`undefined` ⇒ inject nothing), the summary explicitly tells the model to ignore facts
 * irrelevant to the goal, and every probe is fail-soft (an unreadable/unparseable file contributes
 * no fact rather than an error).
 */
export type WorkspaceFacts = {
  /** Prompt-ready summary of every detected fact (generic framing, ignore-if-irrelevant clause). */
  summary: string;
  /**
   * The Node module system, when a root `package.json` was found: how bare `.js` files are loaded.
   * Drives the deterministic module-format lint on authored verification files.
   */
  nodeModuleSystem?: 'esm' | 'commonjs';
};

/** One fail-soft probe: returns a fact line when its file exists (and parses, where relevant). */
type Probe = (root: string) => string | undefined;

const has = (root: string, rel: string): boolean => existsSync(path.join(root, rel));

const MANIFEST_PROBES: Probe[] = [
  (root) =>
    has(root, 'pyproject.toml') || has(root, 'requirements.txt') || has(root, 'setup.py')
      ? 'Python project files present (pyproject.toml / requirements.txt / setup.py).'
      : undefined,
  (root) => (has(root, 'Cargo.toml') ? 'Rust project: Cargo.toml present.' : undefined),
  (root) => (has(root, 'go.mod') ? 'Go project: go.mod present.' : undefined),
  (root) => (has(root, 'Gemfile') ? 'Ruby project: Gemfile present.' : undefined),
  (root) =>
    has(root, 'pom.xml') || has(root, 'build.gradle') || has(root, 'build.gradle.kts')
      ? 'JVM project files present (pom.xml / build.gradle).'
      : undefined,
  (root) => (has(root, 'Makefile') ? 'A Makefile is present.' : undefined),
];

/** Which Node package manager the lockfile pins, so setup/install advice matches the repo. */
function nodeLockfileFact(root: string): string | undefined {
  if (has(root, 'package-lock.json')) return 'Lockfile: package-lock.json (npm — prefer `npm ci`).';
  if (has(root, 'pnpm-lock.yaml')) return 'Lockfile: pnpm-lock.yaml (pnpm).';
  if (has(root, 'yarn.lock')) return 'Lockfile: yarn.lock (yarn).';
  if (has(root, 'bun.lockb') || has(root, 'bun.lock')) return 'Lockfile: bun (bun install).';
  return undefined;
}

/**
 * Probe the workspace once (synchronous, a handful of `stat`s — compose-time wiring, never the
 * frozen contract). Returns `undefined` when nothing recognizable was found: a non-code workspace
 * gets NO injected facts rather than misleading code-flavored ones.
 */
export function detectWorkspaceFacts(root: string): WorkspaceFacts | undefined {
  const lines: string[] = [];
  let nodeModuleSystem: WorkspaceFacts['nodeModuleSystem'];

  const pkgPath = path.join(root, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { type?: unknown };
      nodeModuleSystem = pkg.type === 'module' ? 'esm' : 'commonjs';
      lines.push(
        nodeModuleSystem === 'esm'
          ? 'Node package: package.json declares "type": "module" — bare .js files are ES modules ' +
              '(use import/export); CommonJS require() only works in .cjs files.'
          : 'Node package: package.json without "type": "module" — bare .js files are CommonJS ' +
              '(require/module.exports); ES-module syntax only works in .mjs files.',
      );
      const lock = nodeLockfileFact(root);
      if (lock !== undefined) lines.push(lock);
    } catch {
      // Unparseable manifest: contribute no fact (fail-soft), and no module-format lint either.
    }
  }
  for (const probe of MANIFEST_PROBES) {
    const fact = probe(root);
    if (fact !== undefined) lines.push(fact);
  }

  if (lines.length === 0) return undefined;
  const summary = [
    'WORKSPACE FACTS (detected deterministically from files on disk — the goal need not be about ' +
      'code; ignore any fact irrelevant to it):',
    ...lines.map((l) => `- ${l}`),
  ].join('\n');
  return { summary, ...(nodeModuleSystem !== undefined ? { nodeModuleSystem } : {}) };
}

/**
 * Deterministic module-format lint over the files an authoring compiler wants to freeze: a bare
 * `.js` file whose syntax cannot LOAD under the workspace's detected Node module system (or a
 * `.cjs`/`.mjs` file contradicting its own extension) is refused before freeze, with the concrete
 * fix — the observed haiku failure was exactly this, caught only at pre-flight where it kills the
 * whole run instead of costing one compile-retry. Conservative on purpose: it only fires on
 * unambiguous markers (`require(` / `module.exports` vs top-of-line `import`/`export`), only when
 * a module system was actually detected, and mixed-signal files are left to the runtime. Returns
 * the first offending file + a fix hint, or null.
 */
export function findModuleFormatMismatch(
  files: readonly { path: string; content: string }[],
  system: WorkspaceFacts['nodeModuleSystem'],
): { path: string; problem: string } | null {
  const CJS = /(?:^|[^.\w])require\s*\(|\bmodule\.exports\b|^\s*exports\.\w+\s*=/m;
  const ESM = /^\s*import\s[\w{'"*]|^\s*export\s+(?:default|const|let|var|function|class|\{)/m;
  for (const f of files) {
    const ext = path.extname(f.path);
    const cjs = CJS.test(f.content);
    const esm = ESM.test(f.content);
    if (ext === '.cjs' && esm && !cjs) {
      return {
        path: f.path,
        problem: `'${f.path}' is a .cjs file (always CommonJS) but uses ES-module import/export syntax — use require()/module.exports, or rename it to .mjs`,
      };
    }
    if (ext === '.mjs' && cjs && !esm) {
      return {
        path: f.path,
        problem: `'${f.path}' is an .mjs file (always an ES module) but uses CommonJS require()/module.exports — use import/export, or rename it to .cjs`,
      };
    }
    if (ext !== '.js' || system === undefined) continue;
    if (system === 'esm' && cjs && !esm) {
      return {
        path: f.path,
        problem:
          `'${f.path}' uses CommonJS require()/module.exports, but this package declares ` +
          '"type": "module" so .js files load as ES modules and require() crashes at load ' +
          '(ReferenceError). Use import/export syntax, or name the file with a .cjs extension ' +
          'and invoke it as such',
      };
    }
    if (system === 'commonjs' && esm && !cjs) {
      return {
        path: f.path,
        problem:
          `'${f.path}' uses ES-module import/export, but this package has no "type": "module" so ` +
          '.js files load as CommonJS and import crashes at load. Use require()/module.exports, ' +
          'or name the file with an .mjs extension and invoke it as such',
      };
    }
  }
  return null;
}
