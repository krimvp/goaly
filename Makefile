# goaly — build & dev tasks.  Run `make` (or `make help`) to list targets.
#
# Pass CLI arguments through with ARGS, e.g.:
#   make dev ARGS='run --goal "add a test" --verify-cmd "npm test" --harness droid --autonomous'
#   make run ARGS='help'

SHELL := /bin/bash
.DEFAULT_GOAL := help

# Reinstall deps only when the manifests change (stamp file guards the npm install).
STAMP   := node_modules/.install.stamp
# Sources that, when changed, should trigger a rebuild of the bundle.
SOURCES := $(shell find src -name '*.ts' -not -name '*.test.ts' 2>/dev/null) \
           scripts/build.mjs tsconfig.json tsconfig.build.json package.json
CLI     := dist/goaly.js
ARGS    ?=
# Version bump for `make release`: patch | minor | major (anything `npm version` accepts).
BUMP    ?= patch

.PHONY: help deps dev build run typecheck test test-watch coverage check \
        install uninstall pack release release-publish clean distclean

help: ## Show this help
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

$(STAMP): package.json package-lock.json
	npm install
	@touch $(STAMP)

deps: $(STAMP) ## Install npm dependencies (auto-runs when manifests change)

dev: $(STAMP) ## Run the CLI from SOURCE via tsx — no build. Use ARGS="run --goal ..."
	npm run dev -- $(ARGS)

$(CLI): $(STAMP) $(SOURCES)
	npm run build

build: $(CLI) ## Bundle the standalone CLI + type declarations into dist/

run: $(CLI) ## Run the BUILT CLI from dist/. Use ARGS="..."
	node $(CLI) $(ARGS)

typecheck: $(STAMP) ## Type-check the project (tsc --noEmit, strict)
	npm run typecheck

test: $(STAMP) ## Run the test suite once
	npm test

test-watch: $(STAMP) ## Run the test suite in watch mode
	npm run test:watch

coverage: $(STAMP) ## Run tests with coverage (80% gate)
	npm run coverage

check: typecheck test ## Typecheck + tests (the definition-of-done gate)

install: build ## Install `goaly` globally on your PATH (npm install -g .)
	npm install -g .

uninstall: ## Remove the globally installed `goaly` binary
	npm rm -g goaly

pack: build ## Produce an installable tarball (npm pack)
	npm pack

# --- Release -----------------------------------------------------------------
# Two-step flow that respects branch protection (main needs a PR) and tag
# immutability (v* tags can't be moved/deleted): bump via PR, then release.

release: check ## Open a version-bump PR (BUMP=patch|minor|major). Run on an up-to-date main.
	@test -z "$$(git status --porcelain)" || { echo "release: working tree not clean — commit or stash first."; exit 1; }
	@command -v gh >/dev/null 2>&1 || { echo "release: GitHub CLI (gh) is required."; exit 1; }
	@git fetch --quiet origin main
	@git merge-base --is-ancestor origin/main HEAD || { echo "release: your branch is behind origin/main — pull first."; exit 1; }
	@NEW=$$(npm version "$(BUMP)" --no-git-tag-version) ; \
	  echo "release: bumping to $$NEW" ; \
	  git switch -c "release/$$NEW" ; \
	  git commit -aqm "chore(release): $$NEW" ; \
	  git push -q -u origin "release/$$NEW" ; \
	  gh pr create --fill --title "chore(release): $$NEW" \
	    --body "Version bump to $$NEW. Merge once CI is green, then run \`make release-publish\` on main." ; \
	  echo "" ; \
	  echo "release: next — merge the PR, then on main run: make release-publish"

release-publish: ## After the bump PR merges: cut the GitHub Release for the current version (triggers npm publish).
	@test -z "$$(git status --porcelain)" || { echo "release-publish: working tree not clean."; exit 1; }
	@command -v gh >/dev/null 2>&1 || { echo "release-publish: GitHub CLI (gh) is required."; exit 1; }
	@test "$$(git branch --show-current)" = "main" || { echo "release-publish: switch to main first (git switch main && git pull)."; exit 1; }
	@git fetch --quiet origin main
	@test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" || { echo "release-publish: local main differs from origin/main — pull first."; exit 1; }
	@VER=v$$(node -p "require('./package.json').version") ; \
	  echo "release-publish: creating release $$VER on main" ; \
	  gh release create "$$VER" --target main --generate-notes --title "$$VER" ; \
	  echo "release-publish: published $$VER — watch the 'Publish to npm' workflow in Actions."

clean: ## Remove build output, coverage, and packed tarballs
	rm -rf dist coverage *.tgz

distclean: clean ## clean + remove node_modules
	rm -rf node_modules
