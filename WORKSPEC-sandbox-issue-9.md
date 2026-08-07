# Work spec — Issue #9: opt-in `--sandbox` (Option 3)

> **Status:** spec only. Execution to be run later in **ultracode mode**.
> **Decision (made by maintainer):** Option 3 — ship an **opt-in** sandbox; the default stays
> Option 1 ("assume the caller sandboxes"), so existing behavior is byte-for-byte unchanged unless
> `--sandbox` is passed. The ADR ratifies this; the first slice builds the seam + one real Linux
> mechanism; the rest is filed as follow-up issues.

---

## 0. Why (context, already established)

goaly runs an untrusted coding agent that edits a workspace and runs user/model-authored verifier
commands every iteration. Today the host trust boundary is mitigated but not enforced:

**Already in place (keep, build on):**
- Verifier env credential-scrub — `src/workspace/scrub-env.ts` (`scrubEnv`), applied **only inside**
  `GitWorkspace.run()` via `#scrubVerifyEnv` (default `true`). Git plumbing keeps full env.
- App-level FS path-traversal guards — `GitWorkspace.fileHash`, `writeWorkspaceFile`.
- Subprocess resource bounds — `src/util/spawn.ts` `runProcess`: timeouts, 16 MB output cap,
  `killGroup` (SIGKILL the process group).
- Delegated harness permission modes — claude `--permission-mode acceptEdits`, codex `--full-auto`
  (write) / `--sandbox read-only` (read-only LLM role), droid `--auto`.
- Untrusted-diff / prompt-injection handling at the two keys.

**Missing (this issue):** no OS isolation (no bwrap/firejail/sandbox-exec/container anywhere), no
network-egress control, no `--sandbox` flag, inconsistent FS scoping between seams.

**Encouraging fact:** both untrusted-code execs are already injectable, so the sandbox slots in at
the Driver/composition boundary and the **pure reducer is never touched** (invariant #1):
- Harness/agent CLI exec — `AgentCliHarness` ctor `opts.exec?: AgentExecFn`
  (`src/harness/agent-cli-harness.ts`), default `defaultAgentExec(...)`.
- Verifier — `GitWorkspace.run()` (`src/workspace/git-workspace.ts`). **Subtlety:** `GitWorkspace`'s
  `#exec` is shared by `run()` AND git plumbing; the sandbox must wrap **only the verify command**,
  exactly where `scrubVerifyEnv` is already applied — not diff/diffHash.

---

## 1. Deliverables of the execution phase

1. **ADR** `docs/adr/0007-sandboxing-model.md` (draft text in §6 below — drop-in).
2. **Slice 1 implementation:** the `src/sandbox/` seam + `--sandbox` CLI flag (Zod, fail-closed) +
   the `none` (identity), `bwrap` (Linux), and `container` (docker/podman) launchers, wired into the
   harness and verifier execs in `compose.ts`, with full unit tests. The `container` launcher is the
   portable, cross-platform mechanism (works where bwrap doesn't); `bwrap` is the lightweight Linux
   path. This proves the architecture end-to-end with two real mechanisms.
3. **Docs synced** (definition-of-done gate): README.md, docs/index.html, AGENTS.md directory map,
   and docs/adding-a-harness.md note. See §5.
4. **Follow-up issues filed** for the deferred mechanisms/features. See §7.

Out of scope for slice 1 (→ follow-ups): macOS `sandbox-exec` (native), `firejail` fallback,
network-egress *allowlist* (slice 1 ships binary on/off only), `.goalyrc` per-seam policy tuning,
sandboxing the read-only LLM-provider role. (`container` mode covers macOS via Docker/podman in
slice 1; a native `sandbox-exec` launcher remains a follow-up.)

---

## 2. Architecture — `src/sandbox/` (new seam)

A new leaf module behind an injectable function; **no reducer, no IO in the pure layer**. Mirrors the
"effects live in the Driver, seams are injectable, real + fake" design.

```
src/sandbox/
  policy.ts          SandboxPolicy type + Zod schema; per-seam profiles
  launcher.ts        SandboxLauncher interface + NoneLauncher (identity) + UnavailableLauncher (fail-closed)
  bwrap.ts           BwrapLauncher — rewrites (command,args) into a bubblewrap invocation (PURE; table-testable)
  container.ts       ContainerLauncher — rewrites (command,args) into a docker/podman `run` invocation (PURE; table-testable)
  detect.ts          probe host for an available mechanism; fail-closed when --sandbox requested but none present
  sandboxed-exec.ts  withSandbox(exec, launcher) HOF → wrapped AgentExecFn / ExecFn
  index.ts           makeLauncher(policy) factory (composition helper)
```

### `SandboxLauncher` (the seam interface)
```ts
export interface SandboxLauncher {
  /** Rewrite a command into its jailed form. PURE — no spawn, no IO. */
  wrap(command: string, args: string[], opts: SandboxRunOpts): { command: string; args: string[] };
  readonly mode: SandboxMode; // 'none' | 'bwrap' | ...
}
```
- `NoneLauncher.wrap` = identity (the default; Option 1 preserved exactly).
- `BwrapLauncher.wrap` prefixes `bwrap` with: `--ro-bind / /`, `--bind <workspace> <workspace>`,
  `--dev /dev`, `--proc /proc`, `--tmpfs /tmp`, deny `$HOME` secrets (no bind of `~/.ssh`, `~/.aws`,
  …), `--unshare-net` when `network:'none'`, `--chdir <workspace>`, then `-- command args`.
  All pure string construction → table-tested without spawning.
- `ContainerLauncher.wrap` rewrites into `docker`/`podman run --rm` with `-v <workspace>:<workspace>`
  (rw), `-w <workspace>`, `--network none` when `network:'none'`, `-e` passthrough of the (already
  scrubbed, for the verifier) env, no bind of host `$HOME`/credential dirs, an image from policy
  (default e.g. the host toolchain image, configurable later), then the command+args. The runtime
  (`docker` vs `podman`) and image come from `SandboxPolicy`. Pure string construction →
  table-tested without spawning. Note the cwd/path tension: the workspace path inside the container
  mirrors the host path (bind to the same absolute path) so pinned/relative paths still resolve.
- `UnavailableLauncher` is returned by `makeLauncher` when a mechanism was requested but `detect`
  found it absent; its presence makes the run **refuse to start** (fail-closed, invariant #4) — never
  silently downgrade to unsandboxed.

### Wiring (in `compose.ts`, the composition root only)
- Build `policy` from parsed args. `makeLauncher(policy)` once.
- **Harness exec:** thread a `sandboxedExec` through `makeHarness` → adapter `opts.exec`. The whole
  agent CLI invocation is untrusted → wrap the entire exec.
- **Verifier exec:** wrap **only** `GitWorkspace.run()`. Add a dedicated injection point on
  `GitWorkspace` (e.g. an optional `runLauncher`/`verifyExec`) applied inside `run()` alongside
  `scrubVerifyEnv`; do **not** wrap diff/diffHash git plumbing.
- LLM-provider role (judge/approver/compiler): slice 1 leaves it unsandboxed (read-only at CLI
  level). Note as a follow-up.

### Per-seam default profiles (when `--sandbox` is on)
| Seam | FS | Network (slice 1 default) | Env |
|---|---|---|---|
| Harness (agent CLI) | rw workspace, ro system, deny `$HOME` secrets | **allow** (needs model API) | full (needs API keys) |
| Verifier (`run`) | rw workspace, ro system, deny `$HOME` secrets | **none** (configurable; `npm test` fetch is the known tension — document it) | already scrubbed |

---

## 3. CLI / config surface (parse at every seam — invariant #6)

- `--sandbox[=<mode>]` where `<mode> ∈ {none, auto, bwrap, container}` for slice 1 (schema rejects
  unknown → fail-closed). Default **`none`**. `auto` = detect best available (prefer `bwrap` on
  Linux, else `container` if a docker/podman runtime is present), **refuse to start** if none.
- `--sandbox-image <ref>` / `--sandbox-runtime <docker|podman>` — optional, only meaningful for
  `container` mode (Zod-parsed; defaultable from `.goalyrc`).
- `--sandbox-net=<none|allow>` (or `--sandbox-allow-net` boolean) — binary egress toggle for slice 1.
- Both go through `src/cli/args.ts` Zod parsing; unknown values rejected with a usage error.
- Defaultable from `.goalyrc` via the existing config-overlay seam (like `--harness`,
  `--autonomous`). `--workspace`/`--resume`/`--config` stay non-file per existing rule.
- Help text + `goaly run` usage block updated.

---

## 4. Test plan (TDD; keep coverage ≥ 80%; CLI files excluded — see memory)

- **policy.test.ts** — Zod accepts valid modes; rejects unknown/garbage → fail-closed.
- **bwrap.test.ts** — `wrap()` argv construction is exact and pure (table-driven): network on vs off
  (`--unshare-net`), workspace bind present, `$HOME` secret paths NOT bound, `--chdir`.
- **detect.test.ts** — requested mechanism present → its launcher; absent → `UnavailableLauncher`;
  `auto` with none present → unavailable. (Inject the "which" probe; never touch the real host.)
- **sandboxed-exec.test.ts** — `withSandbox(fakeExec, launcher)` calls the fake with the rewritten
  command/args; `NoneLauncher` is a perfect passthrough.
- **Fail-closed behavioral** — composing a run with `--sandbox=bwrap` while bwrap is "absent"
  (mocked detect) refuses to start: non-zero exit, clear message, **no subprocess spawned**.
- **Regression** — without `--sandbox`, harness + verifier execs are byte-for-byte the current calls
  (NoneLauncher identity) — proves Option 1 default is untouched.
- `npm run typecheck` clean, `npm test` green.

---

## 5. Docs to sync (definition-of-done gate — not optional)

- **README.md** — new "Sandboxing" subsection under/after "Hardening against reward-hacking";
  document `--sandbox`/`--sandbox-net`, the per-seam profiles, the network/FS tensions, and update
  the existing caveat ("only run `--autonomous` against repos you trust" → "…or pass `--sandbox`").
  Add the flags to the usage block.
- **docs/index.html** — landing page: add sandboxing to the hardening area / support matrix.
- **AGENTS.md** — add `sandbox/   policy, launcher, bwrap, detect — opt-in OS isolation (seam)` to
  the directory map. Do **not** add a 9th invariant; reference fail-closed (#4) and parse-at-seam (#6).
- **docs/adding-a-harness.md** — short note: sandbox wrapping is applied by `compose.ts` around the
  injected `exec`, transparent to codecs; codec authors do nothing.
- **docs/adr/0007-sandboxing-model.md** — the ADR (§6).

---

## 6. ADR draft (drop-in for `docs/adr/0007-sandboxing-model.md`)

```markdown
# ADR 0007 — Sandboxing model: opt-in OS isolation, Option-1 default

## Status
Accepted.

## Context
goaly runs an untrusted coding agent that edits the workspace and executes user/model-authored
verifier commands every iteration — untrusted code generation AND untrusted command execution on the
host. In `--autonomous --generate` the verifier itself is fully model-authored. The host trust
boundary is real.

Today goaly mitigates but does not enforce isolation: the verify command runs with a
credential-scrubbed env (`scrubEnv`), path-traversal is guarded, subprocesses are time/output/group
bounded, and harness CLIs carry their own permission modes. There is no OS-level isolation and no
network-egress control. The agent and verifier legitimately need network (model API, packages),
which makes total isolation impractical as a default.

Three stances were considered: (1) assume the caller sandboxes (document it), (2) build sandboxing
in and make it mandatory, (3) opt-in sandbox with the documented assumption as default.

## Decision
**Option 3.** Ship an **opt-in** OS sandbox behind `--sandbox`, defaulting to **off** (Option 1):
without the flag, behavior is unchanged and the caller is responsible for isolation (CI/container).

The sandbox is a new injectable seam (`src/sandbox/`) wrapping the two untrusted-code execs — the
harness/agent CLI and the verifier `run()` — at the composition root. It never touches the pure
reducer (invariant #1) and is selected/parsed like any other flag (invariant #6). When `--sandbox`
is requested but no mechanism is available, the run **refuses to start** rather than silently running
unsandboxed (invariant #4, fail-closed).

Per-seam profiles: the harness gets rw-workspace + ro-system + network (model API) + full env (API
keys); the verifier gets rw-workspace + ro-system + no-network-by-default + the already-scrubbed env.
`$HOME` credential locations (`~/.ssh`, `~/.aws`, …) are denied in both. Git plumbing
(diff/diffHash) is NOT sandboxed — it must read the real `.git`.

First implementation: Linux `bwrap` (bubblewrap), a portable `container` (docker/podman) launcher
(which also covers macOS), and an identity `none` launcher. A native macOS `sandbox-exec` launcher,
a `firejail` fallback, and network-egress *allowlisting* are follow-ups.

## Threat model (what `--sandbox` defends against, and what it does not)
Defends: secret exfiltration via the verifier/agent (FS + env + egress), host FS damage outside the
workspace, reading credentials in `$HOME`, network beaconing (when net is off).
Does NOT defend: a compromised model endpoint the agent is allowed to talk to, supply-chain code
pulled with network on, kernel/sandbox-escape 0-days, or anything when `--sandbox` is off (Option 1).

## Consequences
- A real isolation option exists for untrusted repos without forcing it on trusting users.
- New optional dependency on a host mechanism (bwrap/…); absence is fail-closed, not a silent
  downgrade.
- Network/FS tensions (e.g. `npm test` needing the network) are surfaced as explicit policy toggles,
  documented, not hidden.
- The pure reducer and the eight invariants are untouched; this is a Driver/effects concern.
```

---

## 7. Follow-up issues to file (after the ADR + slice 1 land)

Use `.github/ISSUE_TEMPLATE/feature_request.md` (label `feature`) unless noted:

1. **feat: native macOS `sandbox-exec` launcher** — generated `.sb` profile so Darwin gets a native,
   no-Docker sandbox (slice 1 already covers macOS via `container`/Docker).
2. **feat: network-egress allowlist** — beyond binary on/off: allow model + registry endpoints while
   denying the rest (proxy/firewall). Enhancement on slice 1.
3. **feat: `firejail` fallback launcher (Linux)** — when bwrap is absent.
4. **enhancement: `.goalyrc` per-seam sandbox policy keys** — tune FS binds / net / image per seam
   from config (`enhancement` template).
5. **enhancement: sandbox the read-only LLM-provider role** (judge/approver/compiler CLI) — it's
   read-only at the CLI level but still executes a binary with FS-read + network.

---

## 8. Invariant check (must hold)
- **#1 Zero-LLM reducer** — sandbox is composition/Driver-level; reducer untouched.
- **#4 Fail-closed** — `--sandbox` requested + mechanism absent → refuse to start; a launcher that
  errors → refuse, never an unsandboxed green.
- **#6 Parse at every seam** — `--sandbox`/`--sandbox-net` Zod-parsed; unknown mode rejected.
- **#2/#3/#5/#7/#8** — untouched.
