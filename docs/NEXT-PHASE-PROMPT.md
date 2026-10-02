# Prompt: InstantLead — production-grade phase (paste into a new Claude Code chat opened in C:\dev\instantlead)

You are continuing work on **InstantLead**, a WhatsApp lead-response and booking product for Indian clinics (dental /
skin / hair) and real-estate agents. It is about to be sold to real paying clients. Your job in this phase:
1. Build **two-way Google Calendar sync**.
2. Close every gap that matters for paying clients.
3. Make the whole system **production grade**.

Research properly, decide deliberately, verify everything.

## Read first (in this order)

1. `CLAUDE.md`: conventions. They are binding:
   - Node runs TS directly (`.ts` imports, erasable syntax only)
   - the Clock rule
   - `withTenant` / RLS; `systemDb` only under `apps/api/src/system/`
   - zod at every boundary
   - all LLM calls through the router
   - every reply through `assistant/guard.ts`
   - every outbound message through `sendToLead`
2. `docs/PROGRESS.md`, `docs/DECISIONS.md` (90 numbered decisions; don't silently reverse one), `docs/ROADMAP.md`.
3. `README.md` (architecture), `docs/ONBOARDING.md`, `docs/OPERATIONS.md`, `docs/PRIVACY.md`.
4. The code paths you will touch:
   - `apps/api/src/booking.ts`: slots, booking, leave/closures, running late
   - `apps/api/src/sequences.ts`: reminders, follow-ups, pending/confirm watches
   - `apps/api/src/notify.ts`: lead, staff and calendar side effects
   - `apps/api/src/workers.ts`, `jobs.ts`: pg-boss queues
   - `packages/integrations/src/calendar.ts`: the current one-way Google sync
   - `apps/api/src/system/context.ts`: `calendarFor`, OAuth wiring
   - `apps/api/src/assistant/*`: agent, tools, prompt, guardrails
   - `apps/dashboard/src/pages/*`

**State today:** 264 tests pass. `pnpm demo` 5/5, `pnpm sim` (dental 14/14, real estate 7/7), load test p95 0.5 s,
Playwright e2e pass. All of this is in **mock mode**. **Nothing has run against real Meta WhatsApp, a real LLM, real
Google, Resend, or a real server deployment.**

## How to work

- **Plan mode first.** Explore, research, then write a plan with a recommended approach per item. **Ask me
  (AskUserQuestion) only for real business decisions.** Decide engineering questions yourself and log them in
  `docs/DECISIONS.md`.
- **Verify current official documentation before implementing any external API** (Google Calendar API, Google OAuth
  verification policy, Meta WhatsApp Cloud API, etc.).
  - Fetch the actual pages; don't rely on memory.
  - Record what you verified, and the date, in DECISIONS.
- **Everything must still work in mock mode with zero credentials:** fakes for every new integration, as the
  existing ones do.
- **Tests:** one commit per workstream; tests green after each (`pnpm lint && pnpm typecheck && pnpm test`, then
  `pnpm build`). Re-run `pnpm demo`, `pnpm sim --persona all` (both tenants) and `pnpm e2e` at the end. Update
  PROGRESS, DECISIONS, ROADMAP and CLAUDE.md.
- **Never commit secrets.** Keys live only in `.env`; never ask me to paste keys in chat.
- **Real-model or real-API runs that cost money:** ask first. The eval cap is $8 per run.
- **Commits:** the repo is pushed to `github.com/AnirudhVermaCoding/LeadAutomation` (`main`). Commit as you go; push
  only when I say so.
- **When something is outside this phase,** don't build it. Add it to ROADMAP with a one-line reason.

## Workstream 1: Two-way Google Calendar sync (must build)

**Today:** bookings, reschedules and cancellations are pushed to the clinic's Google Calendar (one-way, OAuth
offline refresh token in `tenant_secrets`). Nothing is read back. If staff block time or add appointments in Google
Calendar, the assistant can still offer those times.

**Research, then decide and build:**
- **Reading busy time:**
  - Compare `freebusy.query` vs `events.list` with **incremental sync (syncToken)** vs **push notifications
    (`events.watch` channels → our webhook)**.
  - Probably: watch + syncToken for freshness, a periodic full re-sync as the safety net, and a FreeBusy re-check
    right before booking.
  - Handle channel expiry and renewal, 410 Gone (full re-sync), webhook auth (channel token), and quota.
- **Mapping:** which calendar(s) map to which resource (doctor / agent)? One calendar per doctor, or one shared
  calendar with events tagged? Decide the model and add a Settings UI to map calendars → resources.
- **Merge:** external busy events become blocked time for slot finding. Store them as their own source, e.g.
  `blocked_times.source = 'google'` + external id, idempotent upserts, deleted when the event is deleted.
- **Ours vs theirs:** our own synced appointments must not be read back as "busy" twice (match on our event id /
  extendedProperties).
- **Conflicts:** an external event created over an existing InstantLead booking feeds the existing "affected
  bookings" flow (`appointmentsAffectedBy`, `handleBlockedAppointments`): staff see it and choose to notify.
  Never auto-message.
- **Double-booking safety:** re-check busy time inside the booking transaction (or immediately before), and keep
  the Postgres exclusion constraint.
- **Timezones and edge cases:** all-day events, tentative / free (transparency) events, declined invitations,
  recurring events (expand with `singleEvents`).
- **Production requirements:**
  - Google OAuth app verification for the calendar scopes (sensitive). Research what is needed for external users
    (privacy policy URL, domain verification, possible security assessment). Note that "testing" mode refresh
    tokens may expire after 7 days. Document what I must do in Google Cloud Console.
  - Token revocation / `invalid_grant` → health alert + "reconnect Google" in Settings.
- **Optional:** consider Microsoft Outlook / Office 365 via Graph behind the same `CalendarProvider` interface.
  Decide whether to build it now or roadmap it.
- **Tests:** a fake Google with sync tokens, channels and 410. DB tests for import, update, delete, conflicts,
  renewal, and booking re-check. A sim or demo step: "staff block 3–5 pm in Google → assistant no longer offers it".

## Workstream 2: Gaps to close (research each, decide, then build or roadmap with a reason)

Known gaps. Verify each in the code first; some may already be partly handled.
1. **Cancelling outside the 24 h WhatsApp window.** When staff cancel a booking and the patient hasn't written in
   24 h, the patient isn't told (there's no general cancellation template). Add a utility template and use it.
2. **One active appointment per lead.** A parent can't book for themselves and a child from the same phone. Decide
   on a "who is this for" / multiple appointments model; check the exclusion constraint, reminders and reports.
3. **Reschedule / cancel completeness:**
   - **already works:** chat ("can I move it to Friday?"), the reminder buttons, the dashboard
   - **to add:** reschedule within policy windows (e.g. no changes < 2 h before, configurable), a cancellation
     policy text, and staff being told about patient-initiated changes (check)
   - an end-to-end test for each path
4. **Opt-out:** a confirmation message, and a re-opt-in flow (the customer messages again and says they want
   messages).
5. **Lead sources not integrated:**
   - Instagram DMs and Facebook Messenger
   - Google Business Profile messages
   - real-estate portals (99acres, MagicBricks, Housing): research what each offers (API, email parsing, CRM
     push); at minimum an email-forward parser or a documented Zapier/Make path into `POST /v1/leads`
   - Practo / JustDial for clinics
   - Decide what's in scope now.
6. **WhatsApp number coexistence.** Clinics want to keep their existing WhatsApp Business app number. Research
   Meta's coexistence / Embedded Signup (Tech Provider) requirements and decide.
7. **Template approval status** synced from Meta's API (today it's marked by hand). Treat Meta error 131050
   (marketing opt-out) correctly.
8. **Staff and owner notifications over WhatsApp** for the weekly report and agency alerts (today: email).
9. **Settings UI** for `ai.*` (allowed providers, budget, routing) and `booking.auto_confirm_pending` (today:
   JSON import / export only).
10. **Dead-letter jobs:** retry / discard actions in the Agency view.
11. **Emergency reply in the lead's language.**
12. **Stale roadmap entry:** "Resource preferences" is now built. Clean the ROADMAP.

## Workstream 3: Production grade (we are selling this)

Audit and fix, with evidence:
- **Deployment:** actually build and run the Docker image (`Dockerfile`, `docker-compose.yml`,
  `deploy/docker-compose.prod.yml`, Caddy). Docker Desktop was broken on this PC, so get it working or use WSL2.
  Write a one-command deploy and rollback, plus zero-downtime migrations guidance.
- **Reliability:**
  - idempotency of every webhook and job
  - retries and dead letters
  - graceful shutdown
  - pg-boss maintenance
  - DB connection limits
  - what happens on Meta / LLM / Google outages: every path ends in a reply or a staff alert, never silence
- **Observability:** structured logs with request / lead / job ids, an error tracker (e.g. Sentry: decide), uptime
  checks, and the health and alerts pages. Make sure no PII is in logs.
- **Security review:**
  - auth and session settings, CSRF, rate limits
  - RLS coverage test, secrets handling and rotation, webhook signatures, SSRF guard
  - dependency audit (`pnpm audit`), CSP
  - a basic penetration checklist; fix what you find
- **Data:** automated off-site backups with a tested restore; retention jobs; DPDP erasure / export checked end to
  end.
- **Scale sanity:**
  - load test with realistic mixes (inbound chats, form bursts, reminder bursts at 09:00)
  - check p95 first reply and the assistant turn latency
  - index review (EXPLAIN on hot queries)
- **Billing readiness:** per-tenant usage (WhatsApp + LLM) is tracked. Decide whether to add simple
  plan / limits enforcement now or roadmap it.

## Questions to answer explicitly in your final report

1. **Memory.** Does the assistant remember a returning customer's history (messages, answers, past
   appointments)? Prove it with a test: a customer who returns after 2 months, plus a long conversation that
   triggers the summary.
2. **Reminders.** Do they survive server restarts, reschedules (old ones cancelled, new ones scheduled), cancels,
   quiet hours and leave? Prove each with a test.
3. **Reschedule and cancel.** Can a patient do both by chat and by reminder buttons, and can staff do both, all
   with the right messages to everyone? List each path and its test.
4. **Calendar.** If staff block time or book in Google Calendar, is that time never offered? What happens to
   bookings already in that time?
5. A **gap table:** built / built-but-unverified-live / roadmap, with reasons.
6. **What I (the owner) must do outside the code:**
   - Google Cloud verification
   - Meta templates (list the new ones)
   - accounts
   - DNS
   - a step-by-step live test script on my own phone before the first real clinic

Start by entering plan mode and exploring. Don't write code until the plan is approved.
