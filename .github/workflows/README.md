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

Because `main` requires a PR and `v*` tags are immutable, releasing is two steps —
both wrapped as `make` targets:

```bash
make release BUMP=patch     # bump version on a release/* branch + open the PR (patch|minor|major)
# ... review, let CI go green, merge the PR ...
git switch main && git pull
make release-publish         # create the GitHub Release for the merged version -> triggers publish
```

What the targets do:

1. **`make release`** runs the gate (`typecheck` + tests), bumps `package.json` with
   `npm version --no-git-tag-version`, and opens a `chore(release): vX.Y.Z` PR. No tag yet —
   the tag is born on `main` so it can't point at a soon-to-be-squashed branch commit.
2. After the PR merges, **`make release-publish`** (run on an up-to-date `main`) calls
   `gh release create vX.Y.Z`, which publishes a GitHub Release and fires the workflow below.

Prefer to do it by hand? The equivalent manual flow:

```bash
git switch -c release/vX.Y.Z
npm version patch --no-git-tag-version
git commit -am "chore(release): vX.Y.Z" && git push -u origin release/vX.Y.Z && gh pr create --fill
# merge, then on main:
gh release create vX.Y.Z --target main --generate-notes
```

> The tag (`v0.1.0`) must match `package.json` (`0.1.0`) or the publish job fails by design.
> If a publish fails, roll **forward** to the next version — the tag ruleset blocks retagging.

### Provenance

Publishing uses [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
which requires the `id-token: write` permission (already set) and a public repo. It attaches a
signed link from the published tarball back to this workflow run — no extra setup needed.
