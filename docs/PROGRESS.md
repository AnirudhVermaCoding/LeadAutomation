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
- Verified: lint, typecheck, all tests incl. DB suite (see M2 note on how).

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
- Verified: lint, typecheck, full suite (107 tests) on real Postgres 16 incl. tenant isolation, M2 messaging flows and HTTP roles. Docker Desktop is broken on the dev machine, so DB tests now use embedded-postgres (no Docker).
- Verified live: `pnpm db:local` + `db:migrate` + `db:seed` (idempotent) + API with workers: API lead -> approved-template first reply (fake channel) in ~2.5 s; hosted form renders with the tenant consent notice.
- Not verified: `docker compose up` (needs Docker) and real Meta credentials.

## M3 — AI assistant

- `packages/core`: deterministic `scoreLead` (weights × option scores, thresholds, disqualifiers), `detectLanguage` (en / hi / hinglish, no LLM), `matchesEmergency`.
- `packages/config`: per-option scores on questions (validated), presets updated.
- `packages/integrations`: `LlmProvider` + Anthropic provider (`claude-sonnet-5-5`), cost calculation.
- `apps/api`: `answers`, `llm_runs`, `leads.score`; assistant turn (`assistant/agent.ts`) with tools `record_answer`, `lookup_knowledge`, `escalate_to_human`, `mark_disqualified` (zod-validated; bad args return an error to the model); emergency pre-check, cost cap, refusal/error handover, bounded loop, reply via `sendToLead`; `assistant-turn` queue (3 s debounce, one turn per lead); rule-based fake assistant for mock mode.
- `packages/sim`: `pnpm sim --tenant demo-clinic --persona <name|all>` — 9 scripted personas with hard checks.
- Verified: lint, typecheck, 134 tests (8 assistant DB tests: qualification + scoring, cache-friendly request shape, debounce, run logging, emergency, human handover, invalid tool args, refusal, cost cap, Hindi holding reply). Live: `pnpm sim --persona all` passes 9/9 against the running app with workers (mock assistant).
- Not verified: real-model behaviour — `assistant.eval.db.test.ts` (injection, invented prices, off-topic, no medical advice, Hinglish replies) needs `RUN_LLM_EVALS=1` and an Anthropic API key. Booking tools come in M4.
