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
