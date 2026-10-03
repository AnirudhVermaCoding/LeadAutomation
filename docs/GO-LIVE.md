# Go-live: what you do outside the code, and the test script

Everything below was written against mock mode (a fake WhatsApp, a fake Google, a rule-based or scripted assistant).
**Nothing has yet run against real Meta WhatsApp, a real model, real Google, Resend, or a real server.** This page is the
path from here to the first paying clinic. Step 3 is the live test script to run on your own phone first.

## 1. Gap table

| Area                                                                                                                                       | Status                                                       | Notes                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two-way Google Calendar (sync, mapping, push channels, 410 recovery, re-check before booking, reconnect banner)                            | **built, tested against an in-memory Google**                | Unverified live: the real Google API, the real consent screen, app verification, real push delivery to your domain. See [GOOGLE-CALENDAR.md](GOOGLE-CALENDAR.md).                                                                                       |
| Outlook / Office 365                                                                                                                       | roadmap                                                      | Separate Microsoft app registration + publisher verification; Graph subscriptions expire in ~3 days; nobody has asked. The provider interface is neutral, so it is one adapter.                                                                         |
| Cancel outside the 24 h window (`il_cancellation`)                                                                                         | built                                                        | Needs Meta approval. A message that can't be sent now alerts staff instead of failing silently.                                                                                                                                                         |
| Several bookings per phone (family)                                                                                                        | built                                                        | One active booking per person; reminders, buttons, calendar and staff alerts per appointment.                                                                                                                                                           |
| Change-notice window + cancellation policy; reschedule / cancel by chat, buttons, dashboard, leave                                         | built, each path has a test                                  |                                                                                                                                                                                                                                                         |
| Opt-out confirmation + customer re-opt-in; staff record opt-out / opt-in                                                                   | built                                                        |                                                                                                                                                                                                                                                         |
| Marketing opt-out (error 131050, `user_preferences` webhook)                                                                               | built                                                        | Payload shape from Meta's docs; unverified live.                                                                                                                                                                                                        |
| Template approval synced from Meta (list + webhooks, PAUSED / DISABLED alert)                                                              | built                                                        | Needs the WhatsApp Business Account id saved; unverified live.                                                                                                                                                                                          |
| Lead sources: website form, API, CSV, Lead Ads, click-to-WhatsApp                                                                          | built (before)                                               |                                                                                                                                                                                                                                                         |
| Lead sources: portal emails (99acres, MagicBricks, Housing, Practo, JustDial)                                                              | built                                                        | **Parser fixtures are synthetic**: forward one real email per portal in the pilot ([LEAD-SOURCES.md](LEAD-SOURCES.md)).                                                                                                                                 |
| Instagram / Messenger DMs, Google Business messages, portal APIs                                                                           | roadmap                                                      | Meta / Google app review; no public push API.                                                                                                                                                                                                           |
| WhatsApp coexistence (keep the existing app number)                                                                                        | roadmap + guide                                              | Needs Tech Provider status; see ONBOARDING.                                                                                                                                                                                                             |
| Weekly report + agency alerts on WhatsApp                                                                                                  | built                                                        | Two new templates; Meta may classify them as marketing.                                                                                                                                                                                                 |
| Settings UI: change policy, auto-confirm, AI providers / budget, retention, report numbers                                                 | built                                                        | Per-task model routing stays JSON.                                                                                                                                                                                                                      |
| Dead-letter retry / discard                                                                                                                | built                                                        |                                                                                                                                                                                                                                                         |
| Emergency reply in Hindi / Hinglish                                                                                                        | built                                                        |                                                                                                                                                                                                                                                         |
| Returning-customer memory (gap, stale answers, past visits, lapsed visits, takeover expiry)                                                | built, tested                                                | `PROMPT_VERSION agent-v3`: **real-model evals not re-run** (they cost money; run `pnpm evals` with your key first).                                                                                                                                     |
| Docker image, compose, Caddy, `deploy.sh` / `rollback.sh` / `backup.sh` / `restore.sh`                                                     | written, syntax-checked, **not run locally**                 | Docker Desktop doesn't start on the dev machine. The CI `docker` job runs all of it once pushed.                                                                                                                                                        |
| Off-site backups + tested restore                                                                                                          | scripts + CI test; **you configure the bucket**              | `BACKUP_RCLONE_REMOTE` / `BACKUP_S3_URI`. Run a restore drill on the VPS.                                                                                                                                                                               |
| Error tracking, heartbeat, log scrubbing, request ids                                                                                      | built                                                        | Sentry / uptime accounts are yours to create.                                                                                                                                                                                                           |
| Security hardening, RLS coverage test, `pnpm audit` clean                                                                                  | built                                                        | [SECURITY.md](SECURITY.md). MFA, WAL archiving, an independent pen test: roadmap.                                                                                                                                                                       |
| Load: p95 first reply 0.5 s (100 leads / 20 s); 60 chatting customers p95 5 s (mock assistant); 156 reminders due at once delivered in 6 s | measured locally                                             | Real model latency (typically 2–6 s per turn) adds on top; real WhatsApp rate limits apply.                                                                                                                                                             |
| Billing: usage by month + CSV, paused-tenant enforcement                                                                                   | built                                                        | Plans, limits, payments: roadmap (you invoice manually in the pilot; pricing is your decision).                                                                                                                                                         |
| Patient timeline + treatment plans (staff-entered), recovery engine, waitlist slot recovery, command center, autonomy settings             | **built, tested in mock mode**                               | Recovery and waitlist messages use 5 new templates (`il_treatment_followup`, `il_recall_due`, `il_lead_reactivation`, `il_slot_offer`, `il_payment_reminder`) that need Meta approval; until then those sends fail visibly (Recovery shows "Not sent"). |
| AI phone receptionist (optional, off by default)                                                                                           | **built, tested against Vapi-format payloads; not run live** | Needs a Vapi account, an Indian number connected through a telecom partner's SIP trunk, and a test call. No outbound calling.                                                                                                                           |
| Supabase / managed Postgres                                                                                                                | documented (OPERATIONS)                                      | Direct connection needed; **migrate step not yet tried on Supabase.**                                                                                                                                                                                   |

## 2. What you must do outside the code

### Google Cloud (once; the long pole is verification, 3–5 business days typical, start now)

Full steps in [GOOGLE-CALENDAR.md](GOOGLE-CALENDAR.md): project + Calendar API, consent screen with a **public homepage and privacy policy on your own domain**, authorized
domain verified in Search Console, scopes `calendar.events` + `calendar.calendarlist.readonly`, OAuth client with redirect `https://<domain>/v1/integrations/google/callback`,
an unlisted YouTube demo video, publish and submit. In **Testing** status refresh tokens die after **7 days**: use Testing only for your own demos; for a pilot publish
"In production" (users see an "unverified app" screen until verified; check the user cap in your console).

### Meta (WhatsApp)

- Business portfolio, a Meta app with the WhatsApp use case; business verification (can take days).
- A **dedicated WhatsApp number per clinic** (not already in a WhatsApp app); display name approval.
- System user + permanent token; `META_APP_SECRET`, `META_VERIFY_TOKEN`; webhook `https://<domain>/webhooks/meta` subscribed to `messages`,
  `message_template_status_update`, `message_template_category_update`, `user_preferences`; `POST /<WABA_ID>/subscribed_apps`.
- Save the **WhatsApp Business Account ID** in Settings → Integrations so approval status syncs.
- **Submit all 22 templates, English and Hindi** (exact names; see [TEMPLATES-TO-SUBMIT.md](TEMPLATES-TO-SUBMIT.md)). New this phase: **`il_cancellation`, `il_report_weekly`, `il_agency_alert`**
  (the last one in _your own_ WABA). Still unapproved from the previous phase: `il_appointment_change`, `il_running_late`, `il_staff_update`. The go-live checklist needs `first_reply`,
  `booking_confirmed`, `booking_pending`, `reminder_24h`, `reminder_2h`, `cancellation`, `appointment_change` and the three `staff_*` templates approved.

### Phone agent (only if the clinic wants it)

- A **Vapi** account and assistant; an **Indian phone number** brought in through your telecom provider's SIP trunk (Vapi's own numbers are not Indian). Check the provider's DLT / KYC requirements for the number.
- In Settings → Phone agent: turn it on, set the transfer number and the disclosure, **Create** the webhook address + secret, add the secret as a Bearer credential in Vapi, paste the system prompt and tools, set a spending limit in Vapi too.
- Call it yourself: book, reschedule, cancel, ask a price, ask for a person (open and closed hours), say an emergency phrase. Check the call appears on the patient's timeline.

### Accounts and infrastructure

- **Anthropic API key** (and run `pnpm evals` once; $8 cap; ask me first, it spends money).
- **Resend** account + a verified sending domain.
- **VPS in India** (Ubuntu 24.04, Docker), a **domain + DNS A record** (`APP_DOMAIN`), firewall 22/80/443.
- **S3-compatible bucket** (ap-south-1, versioning) for backups: `BACKUP_*` in `.env`, cron for `deploy/backup.sh`.
- Optional: Sentry / GlitchTip DSN, a heartbeat monitor URL, an uptime monitor on `/readyz`.
- Docker on your PC: `wsl --update` and restart Docker Desktop (needs admin / a reboot, so I did not do it). Or just push and let CI run the container test.
- A data processing agreement with each clinic; confirm the DPDP basis for portal leads with them.

## 3. Live test script (your own phone, before the first clinic)

Do this on the **staging** deployment with your own WhatsApp number as the "clinic" number, a second phone as the "customer", and a Google account as the "clinic calendar".

1. **Deploy and look:** `deploy/deploy.sh`; `/readyz` is ok; sign in; the go-live checklist shows what is missing.
2. **WhatsApp:** connect the number (phone number id, WABA id, token) → **Test WhatsApp** → templates sync from Meta; fix any not approved.
3. **First reply:** submit the hosted form with the customer phone. A WhatsApp reply arrives in **under a minute**; the checklist ticks "real message delivered".
4. **Conversation:** answer the questions; ask a price (should come from Knowledge, never invented); write in **Hindi** and in **Hinglish**; ask "are you a bot?"; send a **photo** and a **voice note** (fixed reply + staff alert); paste a vendor pitch (tagged "Not a lead").
5. **Emergency phrase:** "my face is swelling badly" → the fixed reply (in the language you wrote) and a staff alert.
6. **Booking:** book by chat. Staff confirm on Today; the customer gets the confirmation; the event appears in Google (title with the service and name).
7. **Family:** from the same phone, book a second appointment "for my daughter Rhea": two events, Today shows "for Rhea".
8. **Reminders:** set the clock-near appointment (book something ~25 h ahead) and wait for the 24 h reminder with Confirm / Reschedule / Cancel; tap **Confirm**; tap **Cancel** on the second one → only that one is cancelled, both phones told.
9. **Reschedule / cancel:** by chat ("can I move it to Friday?"), by the buttons, and from Today (Reschedule dialog). Inside the notice window the assistant refuses and staff are alerted.
10. **Cancel outside 24 h:** cancel from Today for a customer who hasn't written for a day → the `il_cancellation` template arrives with "Book a new time".
11. **Google → us:** in Google Calendar add an event 3–5 pm tomorrow → within ~5 minutes (seconds with push) that time is no longer offered; add one over an existing booking → Today / Blocked times show it as affected and **nothing** is sent until you press "Tell them & offer new times".
12. **Revoke test:** remove the app's access in your Google account security settings → within minutes the dashboard shows "Reconnect Google" and you get the agency alert.
13. **Opt-out:** reply STOP → one confirmation, nothing after; reply START → welcome back; check Inbox / consent record.
14. **WhatsApp marketing opt-out:** use WhatsApp's own "stop marketing messages" control on a follow-up template (if available) → no more follow-ups.
15. **Outage drill:** set a wrong `ANTHROPIC_API_KEY`, message the number → the customer gets the holding reply and staff an alert (never silence). Restore the key.
16. **Backup / restore:** `deploy/backup.sh` → the file is in your bucket → `deploy/restore.sh <file>` into the scratch database prints "ok: RLS intact".
17. **Report:** run the weekly report (or wait for the day): email + WhatsApp one-liner arrive.

If any step fails, fix before the clinic. Then onboard the first clinic with [ONBOARDING.md](ONBOARDING.md); run staff-confirm and watch the Inbox daily for two weeks.

## 4. The questions asked of this phase

1. **Does the assistant remember a returning customer?** Yes: `assistant/memory.db.test.ts` (a lead back after 62 days: earlier messages in order, the gap stated, answers older than 60 days flagged for re-confirmation,
   past visits listed, an unmarked old visit not "upcoming" and not blocking a new booking; a 60+ message conversation is summarised, refreshed every 20 messages, and a failing summariser keeps the last summary;
   a human takeover older than 7 days expires). Real-model behaviour is unverified until `pnpm evals` runs.
2. **Reminders** (`reminders.db.test.ts`, `family.db.test.ts`): survive a restart (a step claimed by a dead worker is reclaimed by a brand-new process and sent once); a reschedule stops the old reminders at once and schedules the new ones only when the booking is confirmed
   (also in staff-confirm mode), and a reminder already queued for the old time is dropped at send time; cancel stops them; quiet hours defer a reminder to 09:00 or skip it if the visit comes first; leave stops them; per-appointment for family bookings.
3. **Reschedule and cancel** (`paths.db.test.ts`, with messages to everyone asserted): customer by chat (reschedule, cancel in window, cancel out of window, refused inside the notice window), customer by reminder buttons (cancel, confirm, reschedule), staff in the dashboard (reschedule, cancel), staff blocking time (leave). Each asserts the patient message, the staff alert, the calendar event and the reminders.
4. **Calendar** (`calendar-sync.db.test.ts`, demo scenario 6): external events block those times and are never offered; moved / deleted events update; free / declined events don't block; our own events are never read back; an event over an existing booking is flagged and **nothing is sent** until staff choose; a booking attempt right after an unsynced external event is caught by the pre-booking check; Google down → booking still goes through and the sync goes stale and alerts.
5. **Gap table:** section 1.
6. **What you do outside the code:** section 2 and the live test script (section 3).

## 5. Verification status of this phase

`pnpm lint`, `pnpm typecheck`, `pnpm test` (400+ tests, real Postgres 16), `pnpm build`, `pnpm demo` (6/6), `pnpm sim` (dental 14/14, real estate 7/7), `pnpm loadtest --mix`, `pnpm e2e` (2/2) all pass locally in mock mode.
Not run: anything against real Meta / Google / Resend / a real model, Docker images and the deploy scripts, and a restore into a real Postgres (CI does the last two).
