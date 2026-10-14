# Convenience targets for local development.
# `make help` lists everything.

SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help setup install env db-up db-down migrate seed reset dev dev-api dev-web \
        build test test-watch test-e2e lint format typecheck verify docker-build \
        docker-up docker-down logs clean

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: install env db-up migrate seed ## One-shot first-time setup
	@echo ""
	@echo "Ready. Start the platform with: make dev"
	@echo "Then open http://localhost:3000"

install: ## Install dependencies and build shared contracts
	npm ci
	npm run build --workspace @shorts/contracts
	npm run db:generate

env: ## Create .env from the template, generating the required secrets
	@if [ -f .env ]; then \
	  echo ".env already exists; leaving it alone."; \
	else \
	  cp .env.example .env; \
	  SESSION=$$(openssl rand -base64 32); \
	  ENCKEY=$$(openssl rand -base64 32); \
	  INTERNAL=$$(openssl rand -hex 24); \
	  ADMIN=$$(openssl rand -base64 18); \
	  sed -i.bak "s|^SESSION_SECRET=.*|SESSION_SECRET=$$SESSION|" .env; \
	  sed -i.bak "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$$ENCKEY|" .env; \
	  sed -i.bak "s|^INTERNAL_API_KEY=.*|INTERNAL_API_KEY=$$INTERNAL|" .env; \
	  sed -i.bak "s|^BOOTSTRAP_ADMIN_PASSWORD=.*|BOOTSTRAP_ADMIN_PASSWORD=$$ADMIN|" .env; \
	  rm -f .env.bak; \
	  echo "Created .env with generated secrets."; \
	  echo "Admin password: $$ADMIN"; \
	fi
	@# Prisma's CLI reads .env from the schema's own directory.
	@ln -sf ../../.env apps/api/.env

db-up: ## Start PostgreSQL
	docker compose up -d postgres
	@echo -n "Waiting for PostgreSQL"
	@for i in $$(seq 1 30); do \
	  if docker exec shorts-postgres pg_isready -U shorts -d shorts >/dev/null 2>&1; then \
	    echo " ready."; exit 0; \
	  fi; \
	  echo -n "."; sleep 1; \
	done; \
	echo " timed out."; exit 1

db-down: ## Stop PostgreSQL
	docker compose down

migrate: ## Apply database migrations
	npm run db:migrate --workspace @shorts/api

seed: ## Insert example characters, ideas, scripts and videos
	npm run db:seed --workspace @shorts/api

reset: ## Drop and recreate the database, then re-seed
	npm run db:reset --workspace @shorts/api

dev: ## Run the API and dashboard together
	npm run dev

dev-api: ## Run only the API
	npm run dev:api

dev-web: ## Run only the dashboard
	npm run dev:web

build: ## Build every workspace
	npm run build

test: ## Unit and integration tests
	npm test

test-watch: ## Tests in watch mode
	npm run test:watch

test-e2e: ## API-level tests
	npm run test:e2e --workspace @shorts/api

lint: ## Lint everything
	npm run lint

format: ## Format everything
	npm run format

typecheck: ## Typecheck every workspace
	npm run typecheck

verify: ## Everything CI runs
	npm run verify

docker-build: ## Build both container images
	docker compose build

docker-up: ## Run the full stack in containers
	docker compose --profile app up -d
	@echo "Dashboard: http://localhost:3000"
	@echo "API:       http://localhost:3001"

docker-down: ## Stop the containerised stack
	docker compose --profile app down

logs: ## Tail container logs
	docker compose logs -f

clean: ## Remove build output and caches
	rm -rf apps/api/dist apps/web/.next packages/contracts/dist
	find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
	@echo "Cleaned. Dependencies and the database are untouched."
