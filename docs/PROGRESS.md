# Progress

## M0 — Scaffold

- pnpm workspace (pnpm 12 via corepack), strict TS 6 with native Node type stripping, ESLint (type-aware) + Prettier, Vitest 5 projects.
- `apps/api`: Fastify 5 with PII-redacting pino, `/healthz`, `/readyz` (DB ping), zod-validated env, graceful shutdown.
- Dockerfile (node:24-slim, no build step), docker-compose (`db` Postgres 16 + `app`), GitHub Actions CI (lint, typecheck, test).
- Docs: CLAUDE.md, DECISIONS, ROADMAP, PROGRESS.
