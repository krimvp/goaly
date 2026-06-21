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
# `make release` knobs: bump the patch/minor/major segment, or pin VERSION=X.Y.Z.
BUMP    ?= patch
VERSION ?=

.PHONY: help deps dev build run typecheck test test-watch coverage check \
        install uninstall pack release clean distclean

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
# Releases are tag-driven: creating a GitHub Release (vX.Y.Z) triggers the
# "Publish to npm" workflow, which derives the version from the tag, builds, and
# publishes to npm. GitHub Actions does the build/version/publish — not you.
# This target is just a CLI shortcut for "Draft a new release" in the GitHub UI.

release: ## Cut a GitHub Release -> Actions publishes to npm. BUMP=patch|minor|major or VERSION=X.Y.Z
	@command -v gh >/dev/null 2>&1 || { echo "release: GitHub CLI (gh) is required."; exit 1; }
	@test -z "$$(git status --porcelain)" || { echo "release: working tree not clean."; exit 1; }
	@test "$$(git branch --show-current)" = "main" || { echo "release: switch to main first (git switch main && git pull)."; exit 1; }
	@git fetch --quiet --tags origin main
	@test "$$(git rev-parse HEAD)" = "$$(git rev-parse origin/main)" || { echo "release: local main differs from origin/main — pull first."; exit 1; }
	@set -e ; \
	  if [ -n "$(VERSION)" ]; then \
	    V="$(VERSION)" ; V="$${V#v}" ; \
	  else \
	    LATEST=$$(git tag -l 'v*' --sort=-v:refname | head -n1) ; \
	    BASE="$${LATEST#v}" ; [ -n "$$BASE" ] || BASE="0.0.0" ; \
	    IFS=. read -r MA MI PA <<< "$$BASE" ; \
	    case "$(BUMP)" in \
	      major) MA=$$((MA + 1)); MI=0; PA=0 ;; \
	      minor) MI=$$((MI + 1)); PA=0 ;; \
	      patch) PA=$$((PA + 1)) ;; \
	      *) echo "release: BUMP must be patch|minor|major (got '$(BUMP)')"; exit 1 ;; \
	    esac ; \
	    V="$$MA.$$MI.$$PA" ; \
	  fi ; \
	  TAG="v$$V" ; \
	  if git rev-parse "$$TAG" >/dev/null 2>&1; then \
	    echo "release: tag $$TAG already exists — versions are immutable, pick another." ; exit 1 ; \
	  fi ; \
	  echo "release: creating GitHub Release $$TAG (Actions will build, version & publish)" ; \
	  gh release create "$$TAG" --target main --generate-notes --title "$$TAG" ; \
	  echo "release: $$TAG created — watch the 'Publish to npm' workflow in the Actions tab."

clean: ## Remove build output, coverage, and packed tarballs
	rm -rf dist coverage *.tgz

distclean: clean ## clean + remove node_modules
	rm -rf node_modules
