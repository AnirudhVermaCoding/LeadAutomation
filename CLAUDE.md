# InstantLead — notes for Claude

Instant WhatsApp lead response + AI qualification + booking for small clinics (real-estate preset).
Spec lives in the original prompt; milestone log in `docs/PROGRESS.md`, decisions in `docs/DECISIONS.md`,
out-of-scope items in `docs/ROADMAP.md`.

## Commands

pnpm is pinned to 12.x via `packageManager`. Node 24 LTS (`.nvmrc`); on this machine it is installed with fnm: `fnm use 24` (or `fnm exec --using=24 <cmd>`).

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
pnpm dev:dashboard  # dashboard dev server on :5173 (API must run on :3000)
pnpm build          # build the dashboard (served by the API from apps/dashboard/dist)
pnpm db:generate    # drizzle-kit generate after editing apps/api/src/db/schema.ts
pnpm db:migrate     # create app role, run migrations, grant
pnpm db:seed        # agency admin + demo tenants (idempotent)
pnpm demo           # 4 acceptance scenarios against the running app (needs AGENCY_ADMIN_* in .env)
pnpm loadtest       # 100 leads / 20 s, pass if p95 first reply < 60 s
pnpm e2e            # Playwright smoke against the running app (seeded)
pnpm secrets:rotate # re-encrypt tenant secrets after setting SECRETS_KEY_PREVIOUS
pnpm evals          # real-model eval suite (RUN_LLM_EVALS=1; $8 cap; EVAL_DRY_RUN=1 for the mock) -> docs/EVALS.md
docker compose up -d --build   # db + one-off migrate + app on :3000
deploy/deploy.sh                # production: build, backup, migrate, swap, auto-rollback (see docs/OPERATIONS.md)
pnpm loadtest --mix             # + 60 chatting customers and a reminder burst
```

## Layout

- `apps/api` — Fastify HTTP, webhooks, workers (one process, `ROLE=all|api|worker`). DB schema, migrations, repositories.
- `packages/core` — pure domain logic (Clock, lead state machine, later scoring/availability). No I/O, no runtime deps.
- `packages/config` — tenant config zod schema, validation, presets (`clinic` dental/skin/hair, `real_estate`), WhatsApp template registry.
- `packages/integrations` — `MessagingChannel` (fake, Meta Cloud API), Meta webhook parsing/signatures (messages, statuses, templates, `user_preferences`, Lead Ads), template list, `CalendarProvider` (Google adapter + in-memory `FakeGoogle`), portal-email lead parser.
- `packages/sim` — `pnpm sim` (scripted personas), `pnpm demo`, `pnpm loadtest` against a running API.
- `e2e/` — Playwright smoke test. `deploy/` — Caddy + production compose overlay. Docs index in README.md.
- `apps/dashboard` — React + Vite + Tailwind + TanStack Query. `pnpm dev:dashboard` (port 5173, proxies to :3000); `pnpm build` → `dist/`, which the API serves same-origin in production. Pages: Today, Inbox, Demo sandbox, Settings, Agency.

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
- **Secrets:** never committed. Per-tenant secrets go through `apps/api/src/secrets.ts` (AES-256-GCM, key ring for rotation). Phone hashes use `ctx.hashKey`, never the rotating secrets key.
- **LLM calls:** never call a provider SDK directly. Use `ctx.router.chain(task, config)` + `loggedCall` (multi-step) or `runStructured` (single JSON task); types from `packages/integrations/src/llm`. Model ids live only in `models.ts` (verified against provider docs) and `DEFAULT_LLM_ROUTING`. Tenants must allow a provider (`ai.allowed_providers`).
- **Assistant guardrails:** every reply goes through `assistant/guard.ts` (`cleanReply` + `checkReply`) before `sendToLead`; customer text sent to any model goes through `redact`. Bump `PROMPT_VERSION` when the prompt changes and re-run `pnpm evals`.
- **Privacy:** erasure/retention live in `apps/api/src/privacy.ts`; outbound webhooks in `webhooks-out.ts` (events table is the outbox).
- **External APIs:** check current official docs before implementing; everything must work in mock mode with zero credentials.
- **Auth:** Better Auth (admin plugin) on the owner connection; roles `agency_admin | client_admin | client_staff`.
  Routes use `guard(ctx, roles, { tenant })`: client users and API keys are pinned to their tenant; only the
  agency admin picks one via `x-tenant-id`. No public sign-up — create users via `ctx.system.createUser`.
- Tests are co-located `*.test.ts`; DB-backed ones are `*.db.test.ts` and use `apps/api/test/context.ts`
  (fresh cloned database + wired app per file). After each milestone: tests green, update `docs/PROGRESS.md`, commit.
- **Google Calendar:** all Google traffic goes through `CalendarProvider`; tests and mock mode run the real adapter against `FakeGoogle` (sync tokens, 410, channels, revocation). Busy time lives in `blocked_times` (`source = 'google'`); sync never messages anyone (staff decide via the leave flow). `invalid_grant` is `GoogleAuthError`, never a retry loop. See docs/GOOGLE-CALENDAR.md.
- **Appointments:** one active booking per person (`attendee_name`); reminders, enrolments and button payloads are per appointment id; customer changes go through `change_notice_hours`; "upcoming" means active and not yet ended (`upcomingAppointments`).
- **Logs and errors:** never log customer data. pino uses `log-scrub.ts` serializers; job failures log ids only; new error paths use `captureError` (`sentry.ts`, optional).
- **Migrations are expand/contract** (the deploy runs them before the new code and a rollback runs the old code on the new schema); `deploy/*.sh` are LF, tested by the CI `docker` job. New template keys reach existing tenants through `migrate.ts` (never overwriting status).
- **Ops employee:** patient = lead (one per phone); timeline in `journey.ts` reads events (`events.lead_id`), messages, calls. Recovery rules in `opportunities.ts` + `packages/core/opportunities.ts` (deterministic, unique `(tenant, kind, subject_key)`); waitlist in `waitlist.ts` (exclusion constraint decides). Clinic autonomy (`autonomyOf`) gates tools in `allowedToolSchemas` and sequences; the never-list is code. Phone agent: `voice.ts` + `packages/integrations/src/voice.ts` (`VoiceProvider`, Vapi), off unless `voice.enabled`. Money only from clinic-entered plan values.
- **Docs index:** GO-LIVE (owner to-do + live test script + gap table), SECURITY, GOOGLE-CALENDAR, LEAD-SOURCES, OPERATIONS, ONBOARDING, PRIVACY, DECISIONS (numbered; don't silently reverse one).
