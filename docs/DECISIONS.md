# Decisions

Format: decision — why — alternative considered.

1. **Node runs TypeScript natively (type stripping, Node >= 24.12); no backend build step.** — Stable since 24.12/25.2; removes tsx/tsup and source maps. Costs: erasable syntax only, `.ts` import extensions. Docker copies the repo and installs prod deps (no `pnpm deploy`, which would put workspace packages under node_modules where Node won't strip types). — Alt: tsx at runtime, or tsdown bundle.
2. **TypeScript 6.0.x, not 7.0.** — typescript-eslint 8.71 supports `<6.1`; type-aware rules (`no-floating-promises`) matter for job code. — Alt: TS 7 without type-aware lint.
3. **drizzle-orm 0.45 (stable), not 1.0 RC.** `pg` driver shared with pg-boss. — Alt: 1.0 RC (move when stable).
4. **pnpm 12 pinned via `packageManager`, run through corepack.** — Current major. pnpm 10's auto-switch to 12 fails on this Windows machine, so use `corepack pnpm` or install pnpm 12 globally.
5. **Packages and tables are created in the milestone that first uses them.** — No empty scaffolding. Target layout is in CLAUDE.md.
6. **One process (`ROLE=all|api|worker`), compose = db + app; dashboard served by Fastify from M6.** — Smallest deployable unit for one VPS; same origin removes CORS for the dashboard. — Alt: separate api/worker/dashboard containers (split when load needs it).
7. **Better Auth instead of Supabase Auth.** — Lives in our Postgres, so mock mode needs zero external credentials.
8. **Tenant isolation = Postgres RLS + `withTenant()` as the single access path.** App connects as a non-owner role without BYPASSRLS; `systemDb` (owner) only under `apps/api/src/system/` (lint-enforced). — Alt: repository-only `where tenant_id = ?` (one forgotten filter leaks data).
9. **Human takeover is an orthogonal `ai_paused` flag, not a funnel state.** — Staff can book/complete a lead during takeover without resuming the AI; UI shows it as a status. — Alt: `human_takeover` state with a remembered resume state (blocks funnel moves).
10. **Business times come from the Clock; `created_at`/`updated_at` are bookkeeping.** — Keeps demo fast-forward and report math consistent.
11. **zod at boundaries via plain `parse` + Fastify error handler; no type-provider plugin.** — One less dependency.
12. **WhatsApp: Meta Cloud API direct first (FIRST_CLIENT_BSP = none).** BSP adapters wait for a client that uses one.
13. **Repo lives at `C:\dev\instantlead`, outside OneDrive.** — OneDrive sync fights node_modules and pnpm links.
14. **Better Auth admin plugin for roles and server-side user creation.** — With `disableSignUp`, the plain sign-up endpoint is blocked even server-side; the admin plugin's `createUser` works without a session when called from the server and sets `role` + `tenantId`. Roles: `agency_admin` (admin permissions), `client_admin`/`client_staff` (none inside Better Auth; app-level guards decide). — Alt: sign-up then patch the row (non-atomic).
15. **API keys use SHA-256, not a password KDF.** — Keys are 192-bit random, so brute force is not a concern; lookup is a single indexed equality.
16. **Tenant secrets bind tenant + name as AES-GCM AAD**, so a ciphertext copied to another tenant's row fails to decrypt. `v1.` prefix leaves room for key rotation (M8).
17. **Config history = append-only `tenant_configs` revisions**; import/export is the same JSON as GET/PUT `/v1/config`.
18. **`.env.example` dev secrets are refused when `NODE_ENV=production`.** — Keeps `docker compose up` zero-config locally without risking a shipped dev key.
19. **DB tests live in a separate Vitest project** (`*.db.test.ts`); each test file clones a migrated template database, so files run in parallel against a clean DB.
20. **Jobs enqueue inside the tenant transaction** (`pg-boss` `fromDrizzle(tx, sql)`), so a lead and its first-reply job commit together; no separate outbox sweeper. The app role gets DML on the `pgboss` schema; pg-boss itself runs as the owner. The `events` table keeps domain history (and feeds outbound webhooks later).
21. **One send path: `sendToLead`.** It checks opt-out, picks free-form vs template from the 24 h window (refusing anything else), refuses unapproved templates on real WhatsApp, records every attempt with an idempotency key, and calls the provider outside the transaction. Permanent failures are recorded and not retried; transient ones throw so pg-boss retries with backoff, then dead-letters. Known ceiling: a crash between the provider call and the status update can re-send (at-least-once).
22. **Opt-out suppression list stores an HMAC of the phone**, keyed with the server secret, per tenant. It survives DPDP erasure of the lead without keeping the number. Opt-out is permanent in v0.
23. **One-word opt-out keywords must be the whole message; phrases may appear anywhere.** Avoids "don't stop, I want to book" unsubscribing someone.
24. **Templates: registry in code (`packages/config/src/templates.ts`), approval status per tenant in the DB.** `docs/TEMPLATES-TO-SUBMIT.md` is generated from the registry and a test fails if it drifts. Positional variables (works with BSPs too). Submitted in `en` + `hi`; Hinglish leads get the English template.
25. **Webhook routing by Meta ids on `tenants`** (`wa_phone_number_id`, `meta_page_id`): one agency Meta app receives every client's webhooks. App secret/verify token are global env; per-tenant tokens are encrypted secrets.
26. **Hosted form is a same-origin page (`/f/:formKey`) embedded by iframe.** No CORS, consent text comes from config, honeypot + per-IP rate limit (`@fastify/rate-limit`).
27. **Duplicate submissions (same phone) don't re-send the first reply.** They update missing name/email and add a consent record. Re-engagement of old leads is the AI's job once they reply.
28. **Graph API pinned to v23.0**, matching Meta's published OpenAPI spec; bump deliberately.
29. **DB tests run on embedded-postgres (real Postgres 16 binaries from npm), not testcontainers.** — Works without Docker or admin rights (Docker Desktop is broken on the dev machine), starts faster, same on CI. `pnpm db:local` uses it for local dev too. Compose remains the deployment path. The cluster is forced to UTF-8 (Windows defaults to WIN1252, which rejects Hindi).
