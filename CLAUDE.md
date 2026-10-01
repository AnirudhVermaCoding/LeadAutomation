# InstantLead — notes for Claude

Instant WhatsApp lead response + AI qualification + booking for small clinics (real-estate preset).
Spec lives in the original prompt; milestone log in `docs/PROGRESS.md`, decisions in `docs/DECISIONS.md`,
out-of-scope items in `docs/ROADMAP.md`.

## Commands

pnpm is pinned to 12.x via `packageManager`; on this machine run it as `corepack pnpm …`.

```bash
cp .env.example .env
pnpm install
pnpm db:local       # Postgres 16 on :5432 without Docker (embedded-postgres, data in .data/pg)
pnpm dev            # API + workers with node --watch (needs Postgres: db:local or docker compose up -d db; then db:migrate)
pnpm lint           # eslint (type-aware)
pnpm typecheck      # tsc --noEmit over the whole workspace
pnpm test           # all vitest projects; *.db.test.ts start a throwaway embedded Postgres 16
pnpm test:fast      # unit + api projects only, no database
pnpm templates:doc  # regenerate docs/TEMPLATES-TO-SUBMIT.md after editing the template registry
pnpm db:generate    # drizzle-kit generate after editing apps/api/src/db/schema.ts
pnpm db:migrate     # create app role, run migrations, grant
pnpm db:seed        # agency admin + demo tenants (idempotent)
docker compose up -d --build   # db + app on :3000
```

## Layout

- `apps/api` — Fastify HTTP, webhooks, workers (one process, `ROLE=all|api|worker`). DB schema, migrations, repositories.
- `packages/core` — pure domain logic (Clock, lead state machine, later scoring/availability). No I/O, no runtime deps.
- `packages/config` — tenant config zod schema, validation, presets (`clinic` dental/skin/hair, `real_estate`), WhatsApp template registry.
- `packages/integrations` — `MessagingChannel` (fake, Meta Cloud API), Meta webhook parsing/signatures, Lead Ads fetch.
- Later: `packages/sim` (M3), `apps/dashboard` (M6). Create packages only when needed.

## Conventions (enforced where possible)

- **Node runs TypeScript directly** (type stripping, Node >= 24.12). So: erasable syntax only (no enums,
  namespaces, parameter properties, decorators), `import type` for types, **relative imports end in `.ts`**,
  no tsconfig `paths`. Workspace packages export `./src/index.ts`.
- **Clock:** domain code never calls `Date.now()` or `new Date()` without args — take a `Clock` (lint rule).
- **Timestamps:** `created_at`/`updated_at` are DB bookkeeping only. Business times (`received_at`, `sent_at`,
  `starts_at`, `due_at`, …) are written from the Clock; reports and sequences read only those.
- **Tenancy:** every tenant table has `tenant_id` + RLS policy via `tenantScoped()`. Touch tenant data only inside
  `withTenant(tenantId, tx => …)`. `systemDb` (owner role, bypasses RLS) may be imported only under
  `apps/api/src/system/**` (lint rule) — use it for pre-tenant lookups only.
- **Messaging:** every outbound message goes through `sendToLead` (apps/api/src/outbound.ts): opt-out, 24 h window, template approval, idempotency key. Jobs are enqueued with `ctx.enqueue(tx, …)` inside the tenant transaction.
- **Validation:** zod at every trust boundary (HTTP bodies, env, webhooks, config, LLM tool args).
- **Secrets:** never committed. Per-tenant secrets go through `apps/api/src/secrets.ts` (AES-256-GCM).
- **External APIs:** check current official docs before implementing; everything must work in mock mode with zero credentials.
- **Auth:** Better Auth (admin plugin) on the owner connection; roles `agency_admin | client_admin | client_staff`.
  Routes use `guard(ctx, roles, { tenant })`: client users and API keys are pinned to their tenant; only the
  agency admin picks one via `x-tenant-id`. No public sign-up — create users via `ctx.system.createUser`.
- Tests are co-located `*.test.ts`; DB-backed ones are `*.db.test.ts` and use `apps/api/test/context.ts`
  (fresh cloned database + wired app per file). After each milestone: tests green, update `docs/PROGRESS.md`, commit.
