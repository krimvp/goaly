/**
 * Live firejail jail-enforcement check (issue #40).
 *
 * The unit tests prove the *argv* FirejailLauncher builds; this proves the jail that argv produces
 * actually ENFORCES when firejail really runs. It uses the REAL FirejailLauncher to build each
 * invocation, then spawns it and asserts:
 *   1. cwd      — the cd-into-workspace shell lands in the workspace
 *   2. ws rw    — the workspace subtree is writable
 *   3. root ro  — the read-only root rejects a write outside the workspace
 *   4. secret   — a $HOME credential dir is unreadable (--blacklist) even though / is visible
 *   5. net=none — the jail has no non-loopback network route
 * Nothing touches the real ~/.ssh: a throwaway $HOME with a fake secret is injected.
 *
 * REQUIREMENT — a NATIVE Linux host. firejail refuses to engage inside a container/VM-namespace
 * (it runs `systemd-detect-virt -c`; anything but `none` makes it print "an existing sandbox was
 * detected" and run the command WITHOUT any sandboxing). WSL2 reports `wsl` there, so firejail
 * no-ops and this test would see false results. The script detects that case and SKIPs.
 *
 * Run from the repo root:  npx tsx scripts/goaly-verify-firejail-live.ts
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { FirejailLauncher } from '../src/sandbox/firejail';

if (spawnSync('which', ['firejail']).status !== 0) {
  console.error('SKIP: firejail not on PATH. Install it (e.g. `sudo apt-get install -y firejail`) then re-run.');
  process.exit(2);
}

// firejail self-disables inside a container/VM-namespace (incl. WSL2). Detect it the way firejail
// does and SKIP — otherwise every jail property would "leak" because firejail applied nothing.
const virt = spawnSync('systemd-detect-virt', ['-c'], { encoding: 'utf8' });
const container = (virt.stdout ?? '').trim();
const probe = spawnSync('firejail', ['--noprofile', '/bin/true'], { encoding: 'utf8' });
if ((container && container !== 'none') || /existing sandbox was detected/.test(probe.stderr ?? '')) {
  console.error(
    `SKIP: firejail will not engage here — it detects a container/VM-namespace` +
      (container ? ` (systemd-detect-virt -c → '${container}')` : '') +
      ` and runs WITHOUT sandboxing. Run this on a NATIVE Linux host (systemd-detect-virt -c → 'none').`,
  );
  process.exit(2);
}

const ws = mkdtempSync(join(tmpdir(), 'goaly-fj-ws-')); // a mktemp-style repo, under /tmp on purpose
const fakeHome = mkdtempSync(join(homedir(), '.goaly-fj-home-')); // NOT under /tmp, so --read-write=/tmp can't re-expose it
mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
const secret = join(fakeHome, '.ssh', 'id_probe');
writeFileSync(secret, 'TOP-SECRET-KEY');

const launcher = new FirejailLauncher(fakeHome);
function jailed(snippet: string, network: 'none' | 'allow' = 'allow') {
  const { command, args } = launcher.wrap('sh', ['-c', snippet], { workspace: ws, network });
  const r = spawnSync(command, args, { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

const results: Array<[boolean, string]> = [];
const check = (pass: boolean, label: string) => results.push([pass, label]);

check(jailed('pwd') === ws, `cwd is the workspace (${ws})`);
check(jailed('touch "$PWD/probe" && echo WROTE').endsWith('WROTE'), 'workspace subtree is writable');
check(jailed('touch /goaly-root-probe 2>/dev/null && echo WROTE || echo BLOCKED') === 'BLOCKED', 'read-only root blocks writes outside the workspace');
const sec = jailed(`cat '${secret}' 2>/dev/null && echo READ || echo BLOCKED`);
check(sec === 'BLOCKED', '$HOME credential dir is blacklisted (unreadable)');
check(jailed('ip route 2>/dev/null | wc -l', 'none') === '0', 'net=none leaves no default/non-loopback route');

rmSync(ws, { recursive: true, force: true });
rmSync(fakeHome, { recursive: true, force: true });

console.log('\n=== Live firejail jail-enforcement ===');
for (const [pass, label] of results) console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`);
const failed = results.filter(([p]) => !p).length;
console.log(failed === 0 ? '\nALL CHECKS PASSED — the jail enforces as built.' : `\n${failed} CHECK(S) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
