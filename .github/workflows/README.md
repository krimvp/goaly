# CI / Publish workflows

Two workflows live here.

## `ci.yml` — on every push to `main` and every PR

Runs `npm ci`, then **typecheck → coverage (tests + 80% thresholds) → build** on Node 20 and 22.
This is the gate that keeps `main` green; nothing publishes from here.

## `publish.yml` — publishes to npm

Triggers when you **publish a GitHub Release**, or manually from the **Actions** tab
(`Run workflow`). It is fully GitHub-driven: the release **tag is the version**. The workflow
derives the version from the tag, re-runs typecheck/test, stamps `package.json` with that version
(in the runner only), builds, and runs `npm publish --provenance --access public`. You never run
`npm version` or `npm publish` locally.

Then the `sync-version` job opens a PR that bumps `package.json` on `main` to the released version
and enables auto-merge, so the repo's version field catches up to npm automatically (see
[Version sync](#version-sync) below).

### One-time setup

1. **`NPM_TOKEN` — publish rights.** On <https://www.npmjs.com> → *Access Tokens* → *Generate New
   Token* → **Automation** (or a *Granular* token scoped to publish `goaly`). Add it under GitHub
   repo → *Settings* → *Secrets and variables* → *Actions* → *New repository secret*, named
   **`NPM_TOKEN`**.
2. **`RELEASE_TOKEN` — opens the version-sync PR.** A [fine-grained PAT](https://github.com/settings/tokens?type=beta)
   scoped to **only this repository** with **Contents: Read and write** and **Pull requests: Read
   and write**. Add it as a second repository secret named **`RELEASE_TOKEN`**. A PAT (rather than
   the default `GITHUB_TOKEN`) is required so the sync PR actually triggers CI — see
   [Version sync](#version-sync). If this secret is missing, releases still publish; only the sync
   PR is skipped.
3. Make sure the `goaly` name is available / owned by your npm account
   (`npm view goaly` — a 404 means it's free).

### Cutting a release

Releasing is a single action — create a GitHub Release. GitHub Actions does the build, version,
and publish. Pick whichever entry point you like:

- **GitHub UI:** *Releases* → *Draft a new release* → *Choose a tag* → type a new `vX.Y.Z` →
  *Publish release*.
- **CLI:** `gh release create vX.Y.Z --generate-notes` (or `make release BUMP=patch` /
  `make release VERSION=X.Y.Z`, which computes the next tag and creates the release for you).
- **Actions tab:** *Publish to npm* → *Run workflow*, passing the version explicitly.

Publishing the release fires the `Publish to npm` workflow, which derives the version from the tag,
builds, and publishes to the registry.

> The release tag is the source of truth for the published version — the workflow stamps
> `package.json` to match at publish time, so no pre-release version bump is needed. The
> `sync-version` job then opens a PR to bring `main`'s `package.json` up to that version.
>
> If a publish fails, fix forward and release the **next** version — the tag ruleset makes `v*`
> tags immutable, so they can't be moved or reused.

### Version sync

After publishing, the `sync-version` job checks out `main`, bumps `package.json` to the released
version on a `chore/sync-version-X.Y.Z` branch, opens a PR, and turns on auto-merge — so once CI is
green the bump merges itself, with no manual step. It no-ops when `package.json` already matches.

Why a PAT (`RELEASE_TOKEN`) and not the built-in `GITHUB_TOKEN`? GitHub deliberately does **not**
run workflows for events triggered by `GITHUB_TOKEN`, so a PR it opens would never get its required
`build (20)` / `build (22)` checks and would sit unmergeable. A PAT acts as you, so the PR triggers
CI normally. Auto-merge also requires *Settings → General → Allow auto-merge* to be enabled.

### Provenance

Publishing uses [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
which requires the `id-token: write` permission (already set) and a public repo. It attaches a
signed link from the published tarball back to this workflow run — no extra setup needed.
