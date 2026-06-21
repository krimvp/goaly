# CI / Publish workflows

Two workflows live here.

## `ci.yml` — on every push to `main` and every PR

Runs `npm ci`, then **typecheck → coverage (tests + 80% thresholds) → build** on Node 20 and 22.
This is the gate that keeps `main` green; nothing publishes from here.

## `publish.yml` — publishes to npm

Triggers when you **publish a GitHub Release**, or manually from the **Actions** tab
(`Run workflow`). It re-runs typecheck/test/build, checks that the release tag matches
`package.json`, and runs `npm publish --provenance --access public`.

### One-time setup

1. **Create an npm token.** On <https://www.npmjs.com> → *Access Tokens* → *Generate New Token* →
   **Automation** (or a *Granular* token scoped to publish the `goaly` package).
2. **Add it as a repo secret.** GitHub repo → *Settings* → *Secrets and variables* → *Actions* →
   *New repository secret*, named **`NPM_TOKEN`**.
3. Make sure the `goaly` name is available / owned by your npm account
   (`npm view goaly` — a 404 means it's free).

### Cutting a release

1. Bump the version and commit it:
   ```bash
   npm version patch   # or minor / major — creates a vX.Y.Z commit + tag
   git push --follow-tags
   ```
2. On GitHub, draft a **Release** for that `vX.Y.Z` tag and **Publish** it.
3. The `Publish to npm` workflow runs and pushes the package to the registry.

> The tag (`v0.1.0`) must match `package.json` (`0.1.0`) or the publish job fails by design.

### Provenance

Publishing uses [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
which requires the `id-token: write` permission (already set) and a public repo. It attaches a
signed link from the published tarball back to this workflow run — no extra setup needed.
