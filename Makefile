# goalorch — build & dev tasks.  Run `make` (or `make help`) to list targets.
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
CLI     := dist/goalorch.js
ARGS    ?=

.PHONY: help deps dev build run typecheck test test-watch coverage check \
        install uninstall pack clean distclean

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

install: build ## Install `goalorch` globally on your PATH (npm install -g .)
	npm install -g .

uninstall: ## Remove the globally installed `goalorch` binary
	npm rm -g goalorch

pack: build ## Produce an installable tarball (npm pack)
	npm pack

clean: ## Remove build output, coverage, and packed tarballs
	rm -rf dist coverage *.tgz

distclean: clean ## clean + remove node_modules
	rm -rf node_modules
