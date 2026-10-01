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

## M4 — Booking

- `packages/core`: availability engine (rules − blocked − busy incl. buffer, multi-resource, min notice), time-zone helpers via `Intl` (DST-safe), spread-out offers, slot labels.
- `packages/integrations`: `EmailProvider` (Resend + fake), `CalendarProvider` (Google one-way + fake), Google OAuth helpers.
- `apps/api`: `availability_rules`, `blocked_times`, `appointments` with an exclusion constraint against double booking (+ backfill of rules for existing tenants); booking module (find slots, book, reschedule, cancel, confirm, complete, no-show); `appointment-notify` job (lead template, staff WhatsApp/email, calendar sync); assistant tools `get_available_slots`, `book_slot`, `reschedule`, `cancel`; routes `/v1/slots`, `/v1/appointments*`, `/v1/availability`, `/v1/blocked-times*`, Google connect/callback.
- Mock assistant books, reschedules and cancels by chat; new sim persona `reschedules_twice`.
- Verified: lint, typecheck, 150 tests (incl. 10-way concurrent booking race, staff-confirm flow with notifications + calendar, reschedule/cancel, blocked times, booking via chat). Live: `pnpm sim --persona all` 10/10 against the running app with workers.
- Not verified: real Google Calendar and Resend credentials.

## M5 — Sequences

- `packages/core`: quiet-hours helpers (wrapping windows), `OffsetClock` for demo fast-forward.
- `apps/api`: `enrollments`, `enrollment_steps`; follow-ups (day 2 / day 5 / unresponsive, email or WhatsApp), reminders (24 h / 2 h) with Confirm / Reschedule / Cancel buttons, no-show recovery, review request; per-minute sweep cron + per-step jobs with retries; stop rules on reply / booking / opt-out / disqualification; quiet hours and deadlines; `POST /v1/dev/clock/advance`.
- Verified: lint, typecheck, 164 tests (10 sequence tests: silent lead day 0→2→5→unresponsive, reply stops follow-ups, email follow-up, reminders + Confirm button + staff alert + review request, Cancel button, no-show recovery, opt-out stops all, duplicate step job, dev clock, quiet hours). Live: real cron sweep runs every minute; a form lead fast-forwarded 48 h got its follow-up deferred over quiet hours and sent at 09:45 IST.

## M6 — Dashboard + Demo Sandbox

- `apps/dashboard`: sign-in; Today (appointments next 3 days with Confirm / Completed / No-show / Cancel); Inbox (filters, conversation with template buttons and delivery ticks, answers, appointment, take over / hand back, staff reply inside the 24 h window); Demo sandbox (form or WhatsApp lead, tappable quick replies, live "what the clinic sees", fast-forward +1 h / +22 h / +2 d / +3 d); Settings (go-live checklist, Business, Questions, Knowledge, Booking incl. bookable hours + blocked times, Messages incl. template approval, Reports, Integrations with WhatsApp / Lead Ads / Google connect, test buttons, website form snippet, API keys; JSON import/export); Agency (usage + cost per tenant, new client from preset, tenant switcher). Loading / empty / error states; mobile layout.
- `apps/api`: `GET /v1/leads/:id`, `/v1/inbox`, takeover / resume, staff send, `/v1/onboarding`, `/v1/integrations/test` (Meta number check, test email), API key management, `/v1/admin/usage`, `/v1/dev/clock`; static dashboard serving with SPA fallback; template buttons stored on messages.
- Verified: lint, typecheck (API + dashboard), build, 169 tests (5 new: inbox actions incl. window enforcement, onboarding, API keys, integration tests, agency usage). Live in the browser: sign-in, Today (desktop + mobile), Inbox, full Sandbox flow (form lead → template + buttons → qualify → offered slots → booked pending → `booking_pending` template), Settings validation error in the save bar.
- Fixed while testing: React crash from `scrollIntoView()` returning a Promise in newer Chromium; static serving of assets built after server start; mobile row layout on Today; tapped-button text in the sandbox.

## M7 — Reports + monitoring

- Weekly report: leads, median first-reply time, reply rate, qualified, booked, shows / no-shows / show rate, estimated revenue from visits, upcoming bookings, topics asked, running cost this month; stored in `reports`, emailed once per period; `GET /v1/reports`, `GET /v1/reports/preview`; dashboard Reports page (live 7-day funnel, KPI tiles, email preview, history).
- Monitoring: derived integration health (`GET /v1/health`, Settings → Integrations → Health); 5-minute monitor with deduped alert emails; dead-letter list; Agency → Monitoring with "Run checks now".
- Verified: lint, typecheck, full suite incl. demo scenario 4 (a week of activity → Monday 09:05 report with exact numbers, sent once) and monitor alert + dedupe. Live: Reports page with real numbers from earlier simulator runs.

## M8 — Hardening, privacy, demo, load test

- Privacy (DPDP): lead erasure (`DELETE /v1/leads/:id`, Inbox → Erase lead; opt-out hash survives), tenant export (`GET /v1/export`, Settings → Your data), per-tenant retention (`privacy.retention_days` + `anonymize|delete`, daily maintenance cron), agency breach register (`/v1/admin/breaches`).
- Outbound webhooks: endpoints per tenant (Settings → Integrations → Webhooks), event outbox claimed by the per-minute sweep, signed delivery job (`x-instantlead-signature: t=…,v1=HMAC`), 5xx/429/network retried, other 4xx final, last status shown.
- Security: `nosniff`, `referrer-policy`, `X-Frame-Options: DENY` (except the embeddable `/f/*` form); `TRUST_PROXY` for Caddy; key rotation (`SECRETS_KEY_PREVIOUS` + `pnpm secrets:rotate`) with a separate stable `HASH_KEY` for opt-out hashes and OAuth state.
- Workers for per-item queues: 0.5 s polling, batches of 10 with per-job results, bursting while batches are full (first replies in parallel). Found by the demo: a backlog of ~200 follow-ups released at once drained at one job per 2 s.
- `pnpm demo` (4 scenarios on fresh tenants over HTTP with clock fast-forward), `pnpm loadtest`, `pnpm e2e` (Playwright smoke, desktop + mobile), `deploy/` (Caddy + prod compose overlay).
- Docs: README (architecture diagram), ONBOARDING, DEMO-SCRIPT, PRIVACY, OPERATIONS (deploy, backups, monitoring, rotation, webhooks, incidents).
- Verified: lint, typecheck, 183 tests (10 new: headers, webhooks create/deliver/sign/4xx/delete, erasure, export, retention, breach register, key rotation). Live against the running app: `pnpm demo` 4/4 (happy path with 2 h reminder + review request; silent lead day 0→2→5→unresponsive; no-show recovery; weekly report leads 3 / replied 1 / booked 2 / shows 1 / no-shows 1 / ₹4,000); `pnpm loadtest` 100 leads in 20 s → first reply p50 0.27 s, p95 0.50 s (was p95 172 s before the worker change); `pnpm e2e` 2/2.
- Not verified: Docker images and the Caddy overlay (Docker Desktop is broken on the dev machine), real Meta / Anthropic / Resend / Google credentials, real-model evals (`RUN_LLM_EVALS=1`).
