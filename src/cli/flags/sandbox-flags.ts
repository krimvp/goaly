import { SandboxPolicy } from '../../sandbox/policy';
import { UsageError, str, type RawFlags } from './tokens';

/**
 * Parse the `--sandbox-net` value into the policy's `network` shape. `none`/`allow` map to the
 * literals; an `allow:<host,host,…>` value (issue #39) maps to an `{ allowlist }` object so only the
 * listed hosts are reachable. Returns the raw value untouched for anything else so the Zod seam
 * produces the usage error (fail-closed, invariant #6).
 */
function parseSandboxNet(net: string): unknown {
  const prefix = 'allow:';
  if (!net.startsWith(prefix)) return net;
  const allowlist = net
    .slice(prefix.length)
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return { allowlist };
}

/**
 * Build the opt-in sandbox policy from the flags, validating each at the Zod seam (invariant #6):
 * an unknown `--sandbox` mode / `--sandbox-net` value / `--sandbox-runtime` is a usage error, never
 * a silent fallback. `--sandbox` with NO value (a boolean flag) means `--sandbox=auto`. Absent flags
 * are omitted so the schema's defaults apply (`mode: 'none'` ⇒ behavior unchanged). The `network`
 * here is the VERIFIER default; the harness seam re-overrides to `allow` downstream UNLESS an
 * allowlist is set (issue #39), in which case the allowlist constrains both seams.
 */
export function parseSandbox(flags: RawFlags): SandboxPolicy {
  const raw = flags['sandbox'];
  // `--sandbox` (boolean) ⇒ auto; `--sandbox=<mode>` ⇒ that mode; absent ⇒ none (the default).
  const mode = raw === true ? 'auto' : raw;
  const net = str(flags, 'sandbox-net');
  const image = str(flags, 'sandbox-image');
  const runtime = str(flags, 'sandbox-runtime');
  const parsed = SandboxPolicy.safeParse({
    ...(mode !== undefined ? { mode } : {}),
    ...(net !== undefined ? { network: parseSandboxNet(net) } : {}),
    ...(image !== undefined ? { image } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.path[0];
    const flag =
      key === 'network'
        ? '--sandbox-net'
        : key === 'runtime'
          ? '--sandbox-runtime'
          : key === 'image'
            ? '--sandbox-image'
            : '--sandbox';
    throw new UsageError(`${flag}: ${issue?.message ?? 'invalid sandbox option'}`);
  }
  return parsed.data;
}
