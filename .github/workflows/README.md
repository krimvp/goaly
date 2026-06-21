# CI / Publish workflows

Two workflows live here.

## `ci.yml` — on every push to `main` and every PR

Runs `npm ci`, then **typecheck → coverage (tests + 80% thresholds) → build** on Node 20 and 22.
This is the gate that keeps `main` green; nothing publishes from here.

## `publish.yml` — publishes to npm

Triggers when you **publish a GitHub Release**, or manually from the **Actions** tab
(`Run workflow`). It is fully GitHub-driven: the release **tag is the version**. The workflow
derives the version from the tag, re-runs typecheck/test, stamps `package.json` with that version
(in the runner only — not committed back), builds, and runs `npm publish --provenance --access
public`. You never run `npm version` or `npm publish` locally.

### One-time setup

1. **Create an npm token.** On <https://www.npmjs.com> → *Access Tokens* → *Generate New Token* →
   **Automation** (or a *Granular* token scoped to publish the `goaly` package).
2. **Add it as a repo secret.** GitHub repo → *Settings* → *Secrets and variables* → *Actions* →
   *New repository secret*, named **`NPM_TOKEN`**.
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
> `package.json` to match at publish time, so no pre-release version bump is needed. The repo's
> `package.json` `version` is just a development baseline and may lag the latest published version.
>
> If a publish fails, fix forward and release the **next** version — the tag ruleset makes `v*`
> tags immutable, so they can't be moved or reused.

### Provenance

Publishing uses [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
which requires the `id-token: write` permission (already set) and a public repo. It attaches a
signed link from the published tarball back to this workflow run — no extra setup needed.
