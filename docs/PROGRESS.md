# Progress

## M0 — Scaffold

- pnpm workspace (pnpm 12 via corepack), strict TS 6 with native Node type stripping, ESLint (type-aware) + Prettier, Vitest 5 projects.
- `apps/api`: Fastify 5 with PII-redacting pino, `/healthz`, `/readyz` (DB ping), zod-validated env, graceful shutdown.
- Dockerfile (node:24-slim, no build step), docker-compose (`db` Postgres 16 + `app`), GitHub Actions CI (lint, typecheck, test).
- Docs: CLAUDE.md, DECISIONS, ROADMAP, PROGRESS.

## M1 — Core

- `packages/core`: `Clock` (`systemClock`, `FakeClock`), lead state machine (explicit transition table, tier on `qualified`, opt-out absorbing, `ai_paused` takeover flag). Matrix snapshot + scenario tests.
- `packages/config`: zod tenant config (spec §5 + `schema_version`), cross-field validation with plain-English `path: message` errors (timezone, languages, duplicates, thresholds, disqualifiers, review link, unknown `{{variables}}`), presets `clinic_dental|skin|hair` and `real_estate`.
- `apps/api`:
  - Schema + first migration: tenants, tenant_configs, users/sessions/accounts/verifications (Better Auth), api_keys, tenant_secrets, audit_log. RLS policy on every tenant table; `tenant_id` defaults to the transaction's tenant.
  - `withTenant()` (the only path to tenant data) on the RLS-bound `instantlead_app` role; `systemDb` (owner) only inside `src/system/`.
  - `pnpm db:migrate` creates the app role, migrates, grants (audit_log append-only, auth tables owner-only).
  - Better Auth email+password at `/api/auth/*`, no public sign-up; role/tenant guards; API-key principals.
  - AES-256-GCM tenant secrets; hashed API keys; audit log.
  - Routes: `GET /v1/me`, `GET|PUT /v1/config`, `GET|POST /v1/admin/tenants`. `pnpm db:seed` creates the agency admin and two demo tenants.
- Verified: lint, typecheck, `test:fast` (unit + api, 21 tests).
- **Not yet verified:** the DB test suite (`tenancy.db.test.ts`, `routes.db.test.ts`: tenant isolation, RLS guard, append-only audit, secrets/API keys against Postgres, HTTP role checks), `docker compose up`, `db:migrate`, `db:seed`. Docker Desktop 4.84 on the dev machine crashes at startup (stale `AppData\Local\Docker\run\dockerInference` socket). Run `pnpm test` once Docker works; CI runs them on push.

## M2 — Intake + channels

- `packages/core`: E.164 normalisation (India-first), 24 h service-window rules (`chooseOutbound` refuses illegal sends), opt-out keyword matching (English/Hinglish/Hindi).
- `packages/config`: template registry (10 templates, `en` + `hi`, utility/marketing, quick-reply buttons with `<key>:<button>` payloads), generated `docs/TEMPLATES-TO-SUBMIT.md`, `intake.opt_out_keywords`.
- `packages/integrations`: `MessagingChannel` with `FakeChannel` and `MetaCloudChannel` (Graph v23.0, error classification retryable vs permanent), webhook signature check + verification handshake, webhook parser (text, template buttons, interactive replies, click-to-WhatsApp referral, statuses, Lead Ads), Lead Ads fetch. Tested against payloads from Meta's OpenAPI spec.
- `apps/api`:
  - Tables: leads, consents, suppressions, conversations, messages, templates, events (all RLS); tenant routing columns + public form key.
  - Intake: `POST /v1/leads` (API key), `POST /v1/leads/import` (CSV, consent column required), hosted form `/f/:formKey`, Meta Lead Ads (webhook → job → Graph fetch), click-to-WhatsApp / organic inbound. Dedupe by phone, consent evidence on every path.
  - pg-boss queues (`first-reply`, `meta-leadgen`, dead letter); jobs enqueue in the same transaction as the lead.
  - `sendToLead` (window, opt-out, template approval, idempotency, cost estimate), inbound handling (dedupe, window, opt-out, state), delivery statuses (monotonic).
  - Routes: `/webhooks/meta`, `/v1/dev/whatsapp/inbound` (mock mode), `/v1/integrations*`, `/v1/templates*`, `/v1/leads`, `/v1/leads/:id/messages`.
- Verified: lint, typecheck, `test:fast` (70 tests: core, config, integrations, CSV, env).
- **Not yet verified:** `messaging.db.test.ts` (intake → first reply, dedupe, consent, window, opt-out incl. after erasure, Meta webhooks, approved templates via Cloud API, statuses, Lead Ads, hosted form, CSV) and all M1 DB tests — they need Docker, which is still broken on this machine.
