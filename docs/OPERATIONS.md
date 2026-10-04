# Operations

## Deploy (single VPS in India, Docker + Caddy)

One small VM runs everything: Postgres, the app (HTTP + workers) and Caddy for HTTPS.
2 vCPU / 4 GB is plenty for dozens of clinics. Pick an Indian region (AWS `ap-south-1` Mumbai,
GCP `asia-south1`, DigitalOcean BLR1, Azure Central India) so patient data stays in India.

**Status:** the images, compose files and scripts below were written and syntax-checked here, but Docker Desktop on the
dev machine does not start, so they have **not been run locally**. The CI `docker` job (`.github/workflows/ci.yml`) builds
the image, starts the stack, runs `pnpm demo` against the container, then takes a backup and restores it into a scratch
database. Treat the first push that goes green there, and your first deploy to the staging VPS, as the real test.

1. Ubuntu 24.04 LTS, Docker Engine + Compose plugin, firewall open only for 22, 80, 443.
2. DNS: an A record for your domain (e.g. `app.example.in`) pointing at the VM.
3. `git clone` the repo, then `cp .env.example .env` and set **real** values (the app refuses to start in production with the
   dev passwords or `dev-only` secrets):

   | Variable                                      | Value                                                                                              |
   | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
   | `NODE_ENV`                                    | `production`                                                                                       |
   | `APP_URL`, `APP_DOMAIN`                       | `https://app.example.in` and `app.example.in` (Caddy's hostname)                                   |
   | `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`        | `openssl rand -hex 24` each; update both `DATABASE_*_URL`s to match                                |
   | `BETTER_AUTH_SECRET`                          | `openssl rand -base64 48`                                                                          |
   | `SECRETS_KEY`                                 | `openssl rand -base64 32`; **back it up offline**, encrypted credentials are unreadable without it |
   | `HASH_KEY`                                    | Set to the same value as `SECRETS_KEY` and never change it (keys the opt-out list)                 |
   | `AGENCY_ADMIN_EMAIL`, `AGENCY_ADMIN_PASSWORD` | The first agency login (12+ characters)                                                            |
   | `META_APP_SECRET`, `META_VERIFY_TOKEN`        | From the Meta app; the verify token is any random string you also enter in Meta                    |
   | `GEMINI_API_KEY`                              | Gemini (paid tier) for the assistant; required in production (mock mode is refused)                |
   | `RESEND_API_KEY`, `EMAIL_FROM`                | Reports and alerts (verify the sending domain in Resend)                                           |
   | `ALERT_EMAIL`                                 | Where operational alerts go                                                                        |
   | `ALERT_WHATSAPP_*`                            | Optional: agency alerts on your own WhatsApp number (template `il_agency_alert`)                   |
   | `SENTRY_DSN`                                  | Optional error tracking (Sentry or self-hosted GlitchTip)                                          |
   | `HEARTBEAT_URL`                               | Optional dead-man's switch: pinged every 5 minutes; your uptime service alerts when it stops       |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`    | Optional Google Calendar; see [GOOGLE-CALENDAR.md](GOOGLE-CALENDAR.md)                             |
   | `BACKUP_RCLONE_REMOTE` or `BACKUP_S3_URI`     | Where backups are copied off the machine (below)                                                   |
   | `ALLOW_FAKE_CHANNEL`, `SEED_PASSWORD`         | Leave unset in production (no sandbox, no demo tenants)                                            |

4. First start:

   ```bash
   docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
   docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml exec app node apps/api/src/system/seed.ts   # agency admin
   ```

   A one-off `migrate` container (roles, migrations, queues, grants, template rows for new keys) runs and must succeed
   before the app starts; the app container never migrates. Caddy gets and renews the TLS certificate; the app port is not exposed.

5. Check `https://<domain>/readyz` returns `{"ok":true}` (database **and** job queue), sign in, then onboard clients ([ONBOARDING.md](ONBOARDING.md)).

### Every later deploy: one command

```bash
git pull && deploy/deploy.sh          # builds instantlead:<commit>, backs up, migrates, swaps, waits for healthy
deploy/rollback.sh                    # back to the previous image (or: deploy/rollback.sh <tag>)
```

`deploy.sh` runs the migrations while the **old** app is still serving, then replaces the app container (a few seconds; Caddy
holds requests for up to 20 s and retries instead of answering 502). If the new app does not become healthy it puts the
previous image back by itself. Jobs live in Postgres, so a restart loses nothing; in-flight ones are retried.

### Zero-downtime migrations: expand, then contract

Because the database is migrated before the new code runs, and a rollback runs old code on the new schema, **every
migration must be compatible with the previous release**:

- **Add** columns as nullable (or with a default); add tables and indexes. Never rename or drop in the same release that stops using it.
- To remove or rename: release 1 stops reading/writing the column; release 2 drops it. To rename: add the new column, write both, backfill, switch reads, drop the old one in a later release.
- A new NOT NULL column needs a default, or a backfill first and the constraint in the next release.
- `CREATE INDEX` on a table with many rows should be `CREATE INDEX CONCURRENTLY` (drizzle migrations run in a transaction, so do that one by hand on the live database first, then ship the migration as `IF NOT EXISTS`). Current tables are small; the hot-path indexes were added while they are.
- The migrator takes an advisory lock (two containers can't migrate at once) and a 10 s `lock_timeout`: a migration that can't get its lock fails fast instead of queueing every query behind it. The deploy then stops before swapping the app.
- Data-destroying changes (drop table/column) are the only thing a rollback can't undo: take the pre-deploy backup (the script does) and note the restore time.

### Managed Postgres instead of the container (Supabase, Mumbai)

Any managed Postgres 16+ in India works (AWS RDS Mumbai, DigitalOcean BLR1, **Supabase in ap-south-1 used as plain Postgres**). A staging project, `instantlead-staging` (ap-south-1, Postgres 17), already has the full schema, the `instantlead_app` role, RLS everywhere and the Data API locked down (checked with Supabase's security advisor: only intentional notes remain).

Set up (on your machine; nothing secret goes in chat or git):

1. Supabase dashboard > Database > Settings: reset the `postgres` password. Supabase > Connect: copy the session-pooler string.
2. `cp .env.supabase.example .env.supabase` and fill it in (`.env*` is gitignored). Pick a long random `APP_DB_PASSWORD`.
3. `pnpm db:migrate` (sets the app role's password, applies any new migration, backfills template rows) then `pnpm db:seed`, with those variables loaded.
4. Run the app against it (`DATABASE_URL`, `DATABASE_OWNER_URL`), and drop the `db` service from compose if you deploy this way.

Rules that matter:

- Use the **direct** connection or the **session pooler** (port 5432). pg-boss and the migration lock need LISTEN/NOTIFY-class session features, advisory locks and prepared statements that the transaction pooler (port 6543) does not provide. Direct is IPv6-only unless you buy the IPv4 add-on; the session pooler is IPv4. On the pooler the login is `instantlead_app.<project-ref>`; the migrator reads the role from before the dot.
- Add `?sslmode=no-verify` (encrypted, CA not checked) or load Supabase's CA to verify.
- **The Data API is off-limits by design.** Supabase grants `anon` / `authenticated` access to new `public` tables by default. The migrator revokes that, turns RLS on for every table (including the auth tables, which have no policy: deny-all) and changes the default privileges for future tables. Tested in `lockdown.db.test.ts`. We never use the REST API, Supabase Auth or Realtime; consider switching the Data API off in the dashboard too.
- `btree_gist` is installed in `public` (the advisor warns; harmless here, since `appointments_no_overlap` depends on it).
- Backups: Supabase Pro keeps 7 daily backups; point-in-time recovery is a paid add-on; restores cause downtime; custom role passwords are not in its backups (our migrate step re-applies the app role). Keep running `deploy/backup.sh` to your own bucket as well.
- **Free tier = staging only** (no backups, pauses after a week idle). Move to Pro in Mumbai before any real patient data.
- The app has been tested against local Postgres only; it has not yet run live against Supabase. The first `pnpm db:migrate` + `pnpm dev` there is the real test (the schema itself was applied and checked through Supabase's SQL tool).

**Scaling later:** run a second app container with `ROLE=worker` and set the web one to `ROLE=api`. Nothing else changes.

## Backups and restore

```bash
# /etc/cron.d/instantlead-backup   (nightly; 14 days kept locally; the off-site copy follows your bucket's lifecycle rule)
15 3 * * * root cd /opt/instantlead && deploy/backup.sh >> /var/log/instantlead-backup.log 2>&1
```

`deploy/backup.sh` writes a compressed `pg_dump -Fc`, checks it is readable (`pg_restore -l`), optionally encrypts it
(`BACKUP_GPG_PASSPHRASE_FILE`), **copies it off the machine** (`BACKUP_RCLONE_REMOTE` or `BACKUP_S3_URI`) and prunes old
local copies. Without an off-site destination it warns loudly. Use a bucket in `ap-south-1` with versioning and a lifecycle rule (e.g. 30 days).
Recovery point: up to 24 hours (a nightly logical dump). If that is too much, add WAL archiving or a managed Postgres with point-in-time recovery.

```bash
deploy/restore.sh /var/backups/instantlead/instantlead-nightly-<stamp>.dump        # into a SCRATCH database; verifies RLS
# replacing production (app stopped):  deploy/restore.sh <dump> instantlead --replace
```

A bare `pg_restore` onto a fresh server would lose the `instantlead_app` role and its grants (cluster-level, not in the dump), and the
row-level-security policies that name that role would fail to load. `restore.sh` creates the role first, restores, re-runs the app's
migrate step (grants, queues), then `deploy/restore-check.sh` proves: RLS is on with a policy for every tenant table, the app role can't bypass it,
no tenant is visible without a tenant context, and one tenant sees only its own rows. CI runs this against a freshly seeded stack on every push.

The backup is useless without `SECRETS_KEY` and `HASH_KEY`; store them separately (password manager). **Run a restore drill every quarter** (to the scratch database, on the VPS).
Erased leads come back if you restore an older backup; re-run erasures recorded in `audit_log` (`action = 'lead.erased'`) after a restore.

## Monitoring

- **Health endpoints:** `/healthz` (process up) and `/readyz` (database **and** job queue reachable) for an uptime checker (UptimeRobot, Better Stack), every minute. Also set `HEARTBEAT_URL` to a heartbeat monitor: the monitor job pings it every 5 minutes, so you hear about dead workers, not just a dead web server.
- **Built-in monitor** (every 5 minutes) emails `ALERT_EMAIL` (and WhatsApps you if `ALERT_WHATSAPP_*` is set) about: repeated failed WhatsApp sends, AI errors, no delivery receipts for sent messages (the Meta webhook is probably broken), job backlog, dead-lettered jobs, a client's Google Calendar access lost or stale, a WhatsApp template Meta paused or disabled, AI budget at 80%. Alerts are deduped and repeat at most every 6 hours while the problem lasts.
- **Agency → Monitoring:** recent alerts and dead-lettered jobs with **Retry** / **Discard**; **Run checks now** triggers the monitor.
- **Per clinic:** Settings → Integrations → Health (last send, last delivery receipt, last inbound message, failures in 24 h).
- **Logs:** `docker compose logs -f app` (JSON, rotated: 5 x 10 MB). Every request has an `x-request-id` (send your own to trace a call); every job failure logs queue, job id, tenant id and lead id, never message text or phone numbers (errors are scrubbed of SQL parameters, emails and numbers; query strings of webhook and OAuth URLs are dropped). **Error tracking:** set `SENTRY_DSN` (Sentry, or self-hosted GlitchTip) for grouped exceptions; nothing leaves the process without scrubbing.
- **Lost password:** there is no email reset. Agency admin: `POST /v1/admin/users/reset-password {email, password}` (12+ characters); that user is signed out everywhere.
- **Pausing a client** (non-payment): `POST /v1/admin/tenants/<id>/status {"status":"paused"}`: sends and the AI stop, leads are still recorded, the dashboard shows a banner. `"active"` resumes. Usage for invoices: `GET /v1/admin/usage?month=2026-10&format=csv`.

## Rotating secrets

| Secret                                      | How                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SECRETS_KEY` (encrypts clinic credentials) | 1. Make sure `HASH_KEY` is set to the **current** `SECRETS_KEY` (opt-out hashes depend on it). 2. Set `SECRETS_KEY_PREVIOUS` = old key and `SECRETS_KEY` = `openssl rand -base64 32`. 3. Restart the app, which can now read both. 4. `docker compose exec app node apps/api/src/system/rotate-secrets.ts` (or `pnpm secrets:rotate`) re-encrypts everything with the new key. 5. Remove `SECRETS_KEY_PREVIOUS`, restart. |
| `BETTER_AUTH_SECRET`                        | Change and restart; everyone signs in again.                                                                                                                                                                                                                                                                                                                                                                              |
| `META_APP_SECRET`                           | Reset in the Meta app, update `.env`, restart right away (webhooks fail signature checks in between and Meta retries them).                                                                                                                                                                                                                                                                                               |
| Clinic WhatsApp / Page tokens               | Generate a new system-user token, paste it in Settings → Integrations.                                                                                                                                                                                                                                                                                                                                                    |
| Database passwords                          | `ALTER ROLE … PASSWORD`, update `.env`, restart.                                                                                                                                                                                                                                                                                                                                                                          |
| API keys, webhook secrets                   | The clinic creates a new one and deletes the old in Settings → Integrations.                                                                                                                                                                                                                                                                                                                                              |

## Outbound webhooks

Clinics can add endpoints (Settings → Integrations → Webhooks) for `lead.created`, `lead.qualified`,
`appointment.booked`, `appointment.completed`, `lead.opted_out`. Each event is POSTed as JSON:

```json
{
  "id": "<event id>",
  "type": "lead.created",
  "occurred_at": "2026-10-05T04:30:00.000Z",
  "data": {
    "leadId": "…",
    "lead": {
      "id": "…",
      "name": "Priya",
      "phone": "+919811100001",
      "email": null,
      "state": "contacted",
      "tier": null,
      "source": "api"
    }
  }
}
```

Headers: `x-instantlead-event`, and `x-instantlead-signature: t=<unix seconds>,v1=<hex>` where
`v1 = HMAC-SHA256(secret, "<t>.<raw body>")`. Receivers should verify it and reject a `t` older than 5 minutes.
Events are sent within a minute. 5xx, 429 and timeouts are retried with backoff (about 10 minutes, then dead-lettered),
and other 4xx are not retried. Delivery is at least once, so dedupe on `id`. An erased lead's data is never sent.

## Incidents

**WhatsApp replies stopped.** Check Settings → Integrations → Health for that clinic. If sends fail with auth errors,
the token was revoked: create a new one. If sends succeed but no delivery receipts arrive, the webhook subscription
is broken: re-check the callback in the Meta app and `POST /<WABA_ID>/subscribed_apps`. If the number was flagged
for quality, pause follow-ups (Settings → Messages) and check WhatsApp Manager.

**App down.** `docker compose ps`, `docker compose logs --tail 200 app`. Database full? `df -h`. Restart with
`docker compose up -d`. Meta retries webhooks for a while, and form leads queued while the app was up are not lost.

**AI misbehaving.** Take over the affected conversations from the Inbox (pauses the AI per lead). To stop the AI
everywhere, unset the AI provider keys (`GEMINI_API_KEY`) and restart; the rule-based assistant takes over.

### Incident: personal data breach

1. Contain: revoke the leaked credential, rotate secrets (above), lock affected accounts.
2. Record it at once in the breach register (`POST /v1/admin/breaches` as agency admin): detection time, description, clinic, people affected.
3. Tell the affected clinic(s) immediately; as Data Fiduciary they notify affected people.
4. Notify the Data Protection Board without delay, with a detailed report within 72 hours (DPDP Rules); update the register with `reportedToBoardAt` and `usersNotifiedAt`.
5. Write up the root cause and fix.
