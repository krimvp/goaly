import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectWorkspaceFacts, findModuleFormatMismatch } from './workspace-facts';

function dir(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'goaly-facts-'));
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}

describe('detectWorkspaceFacts — detected, never assumed', () => {
  it('returns undefined for a workspace with no recognized manifests (non-code context)', () => {
    expect(detectWorkspaceFacts(dir({ 'notes.md': '# essay drafts' }))).toBeUndefined();
  });

  it('detects an ESM Node package and frames the .js consequence concretely', () => {
    const facts = detectWorkspaceFacts(
      dir({ 'package.json': JSON.stringify({ name: 'x', type: 'module' }) }),
    );
    expect(facts?.nodeModuleSystem).toBe('esm');
    expect(facts?.summary).toContain('"type": "module"');
    expect(facts?.summary).toContain('.js files are ES modules');
    // The generic framing: facts may be irrelevant to a non-code goal.
    expect(facts?.summary).toContain('ignore any fact irrelevant');
  });

  it('detects a CommonJS Node package (no "type") and the lockfile', () => {
    const facts = detectWorkspaceFacts(
      dir({ 'package.json': JSON.stringify({ name: 'x' }), 'package-lock.json': '{}' }),
    );
    expect(facts?.nodeModuleSystem).toBe('commonjs');
    expect(facts?.summary).toContain('CommonJS');
    expect(facts?.summary).toContain('npm ci');
  });

  it('an unparseable package.json contributes no fact and no module system (fail-soft)', () => {
    const facts = detectWorkspaceFacts(dir({ 'package.json': '{not json', 'Makefile': 'all:' }));
    expect(facts?.nodeModuleSystem).toBeUndefined();
    expect(facts?.summary).toContain('Makefile');
    expect(facts?.summary).not.toContain('package.json');
  });

  it('detects non-Node manifests (python / rust / go)', () => {
    const facts = detectWorkspaceFacts(
      dir({ 'pyproject.toml': '[project]', 'Cargo.toml': '[package]', 'go.mod': 'module x' }),
    );
    expect(facts?.summary).toContain('Python');
    expect(facts?.summary).toContain('Cargo.toml');
    expect(facts?.summary).toContain('go.mod');
    expect(facts?.nodeModuleSystem).toBeUndefined();
  });
});

describe('findModuleFormatMismatch — deterministic pre-freeze lint', () => {
  const cjsContent = "const fs = require('fs');\nmodule.exports = {};\n";
  const esmContent = "import fs from 'node:fs';\nexport const x = 1;\n";

  it('flags require() in a bare .js file of an ESM package (the observed run-1/7 killer)', () => {
    const hit = findModuleFormatMismatch([{ path: 'verify.js', content: cjsContent }], 'esm');
    expect(hit?.path).toBe('verify.js');
    expect(hit?.problem).toContain('require()');
    expect(hit?.problem).toContain('.cjs');
  });

  it('flags import in a bare .js file of a CommonJS package', () => {
    const hit = findModuleFormatMismatch([{ path: 'verify.js', content: esmContent }], 'commonjs');
    expect(hit?.problem).toContain('.mjs');
  });

  it('extension-explicit files are checked against their OWN extension, regardless of package type', () => {
    expect(
      findModuleFormatMismatch([{ path: 'verify.cjs', content: esmContent }], 'esm')?.problem,
    ).toContain('.cjs file');
    expect(
      findModuleFormatMismatch([{ path: 'verify.mjs', content: cjsContent }], 'commonjs')?.problem,
    ).toContain('.mjs file');
  });

  it('passes matching formats and stays silent with no detected module system (non-code workspace)', () => {
    expect(findModuleFormatMismatch([{ path: 'verify.js', content: esmContent }], 'esm')).toBeNull();
    expect(
      findModuleFormatMismatch([{ path: 'verify.js', content: cjsContent }], 'commonjs'),
    ).toBeNull();
    expect(findModuleFormatMismatch([{ path: 'verify.js', content: cjsContent }], undefined)).toBeNull();
    // Non-JS files are never linted.
    expect(findModuleFormatMismatch([{ path: 'check.py', content: cjsContent }], 'esm')).toBeNull();
  });

  it('leaves mixed-signal files to the runtime (conservative: no false COMPILE_FAILED)', () => {
    const mixed = "import fs from 'node:fs';\nconst dyn = require('./x.cjs');\n";
    expect(findModuleFormatMismatch([{ path: 'verify.js', content: mixed }], 'esm')).toBeNull();
  });
});
