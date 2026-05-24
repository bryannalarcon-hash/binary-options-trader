# =============================================================================
# Meridian — Makefile
# Convenience targets for the monorepo.
# =============================================================================

.DEFAULT_GOAL := help
.PHONY: help install build build-program build-app build-automation \
        localnet localnet-stop deploy bootstrap dev test test-anchor e2e e2e-up e2e-down clean

SHELL := /usr/bin/env bash

help: ## Show this help
	@echo "Meridian — available targets:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
	  awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'
	@echo ""

install: ## Install all JS/TS deps (pnpm workspace)
	pnpm install

build: build-program build-app build-automation ## Build everything (program + frontend + automation)

build-program: ## Build the Anchor program (SBF bytecode only — IDL generated separately)
	# `--no-idl` works around an Anchor 0.30.1 limitation: its IDL builder
	# relies on `proc_macro2::Span::source_file()`, an API that was removed
	# from stable rustc 1.84+ and from proc-macro2 1.0.94+. We generate the
	# SBF binary here and produce the IDL TypeScript bindings via a hand-
	# written client (see app/lib/anchor-client.ts) until upgrading to
	# Anchor 0.31+ in a later phase.
	anchor build --no-idl

build-app: ## Build the Next.js frontend
	pnpm --filter app build

build-automation: ## Build the automation service
	pnpm --filter automation build

localnet: ## Start solana-test-validator + fund wallets
	./scripts/dev-localnet.sh

localnet-stop: ## Stop the local validator
	./scripts/dev-localnet.sh stop

deploy: ## Deploy the program to localnet
	anchor deploy --provider.cluster localnet

bootstrap: ## Deploy + mint USDC + init config + run morning job (localnet)
	./scripts/bootstrap-localnet.sh

dev: ## Run app + automation concurrently (validator must be up)
	pnpm dev

test: test-anchor ## Run all tests (alias)

test-anchor: ## Run Anchor mocha tests
	anchor test

e2e: ## Run Playwright e2e tests (stack must be up)
	pnpm --filter tests test:e2e

e2e-up: ## Bring up the full e2e stack (validator + deploy + bootstrap + app + automation)
	./scripts/e2e-up.sh

e2e-down: ## Tear down the full e2e stack
	./scripts/e2e-down.sh

clean: ## Remove build artifacts
	rm -rf target .anchor node_modules app/.next app/node_modules automation/dist automation/node_modules
