import { describe, it, expect } from 'vitest';
import { parseArgs } from './args';
import { renderResolvedConfig } from './dry-run';

/**
 * `--dry-run`. There was no way to find out whether a `.goalyrc` parsed, which layer won a flag, or
 * what the verifier intent resolved to without starting a real run — minting a run directory and
 * burning authoring tokens to read back a config. For a tool whose pitch is freezing the bar BEFORE
 * spending anything, that was backwards.
 *
 * The renderer is pure, so these assert on the text with no filesystem involved.
 */
describe('renderResolvedConfig', () => {
  async function render(argv: string[]): Promise<string> {
    const parsed = await parseArgs(argv);
    return renderResolvedConfig(parsed, parsed.config);
  }

  it('states plainly that nothing ran', async () => {
    const out = await render(['run', '--goal', 'g', '--verify-cmd', 'npm test']);
    expect(out).toContain('--dry-run');
    expect(out).toContain('no run directory, no lock, no tokens spent');
  });

  it('shows the RESOLVED verifier intent, not the raw flags', async () => {
    expect(await render(['run', '--goal', 'g', '--verify-cmd', 'npm test'])).toContain(
      'existing command: npm test',
    );
    const generated = await render(['run', '--goal', 'g', '--generate', '--intent', 'add a vitest']);
    expect(generated).toContain('generate (intent: add a vitest)');
  });

  it('shows the agent wiring, including the autonomy tier and its default', async () => {
    const base = await render(['run', '--goal', 'g', '--verify-cmd', 'true', '--harness', 'droid']);
    expect(base).toMatch(/harness\s+droid/);
    expect(base).toContain("(the CLI's own default)");
    const raised = await render([
      'run', '--goal', 'g', '--verify-cmd', 'true', '--harness', 'droid', '--harness-autonomy', 'medium',
    ]);
    expect(raised).toMatch(/harness-autonomy\s+medium/);
  });

  it('shows the stuck thresholds a run would actually use', async () => {
    const out = await render([
      'run', '--goal', 'g', '--verify-cmd', 'true', '--stuck-crash-threshold', '4',
    ]);
    expect(out).toMatch(/crash threshold\s+4/);
    expect(out).toMatch(/unevaluable threshold\s+2/); // the untouched default, shown explicitly
  });

  it('reports budgets as "unlimited" rather than blank when uncapped', async () => {
    const out = await render(['run', '--goal', 'g', '--verify-cmd', 'true']);
    expect(out).toMatch(/budget-tokens\s+unlimited/);
    expect(out).toMatch(/budget-wall-ms\s+unlimited/);
  });

  it('names the config files that contributed, or says none', async () => {
    expect(await render(['run', '--goal', 'g', '--verify-cmd', 'true'])).toMatch(
      /config files\s+\(none\)/,
    );
  });

  it('only shows the phased knobs on a phased run', async () => {
    expect(await render(['run', '--goal', 'g', '--verify-cmd', 'true'])).not.toContain(
      'max-plan-retries',
    );
    expect(await render(['run', '--goal', 'g', '--verify-cmd', 'true', '--phased'])).toContain(
      'max-plan-retries',
    );
  });

  it('omits absent optional rows entirely (never prints "undefined")', async () => {
    const out = await render(['run', '--goal', 'g', '--verify-cmd', 'true']);
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('judge-model');
  });

  it('surfaces parse warnings at the top, where they cannot be missed', async () => {
    const parsed = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true']);
    const out = renderResolvedConfig(
      { ...parsed, warnings: ['--generate overrides the verify-cmd from .goalyrc'] },
      parsed.config,
    );
    expect(out).toContain('! --generate overrides');
    // Above the first section heading.
    expect(out.indexOf('! --generate')).toBeLessThan(out.indexOf('Goal & contract'));
  });
});
