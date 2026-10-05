# Operations

## Deploy (single VPS in India, Docker + Caddy)

One small VM runs the app (HTTP + workers) and Caddy for HTTPS. **The database is Supabase** (Free plan for the pilot, Mumbai); the
local Postgres container in `docker-compose.yml` is for development and CI only and never starts in production.
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

   | Variable                                      | Value                                                                                                   |
   | --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
   | `NODE_ENV`                                    | `production`                                                                                            |
   | `APP_URL`, `APP_DOMAIN`                       | `https://app.example.in` and `app.example.in` (Caddy's hostname)                                        |
   | `DATABASE_OWNER_URL`, `DATABASE_URL`          | Supabase session pooler URLs (see "Database: Supabase" below); the deploy refuses to start without them |
   | `BETTER_AUTH_SECRET`                          | `openssl rand -base64 48`                                                                               |
   | `SECRETS_KEY`                                 | `openssl rand -base64 32`; **back it up offline**, encrypted credentials are unreadable without it      |
   | `HASH_KEY`                                    | Set to the same value as `SECRETS_KEY` and never change it (keys the opt-out list)                      |
   | `AGENCY_ADMIN_EMAIL`, `AGENCY_ADMIN_PASSWORD` | The first agency login (12+ characters)                                                                 |
   | `META_APP_SECRET`, `META_VERIFY_TOKEN`        | From the Meta app; the verify token is any random string you also enter in Meta                         |
   | `GEMINI_API_KEY`                              | Gemini (paid tier) for the assistant; required in production (mock mode is refused)                     |
   | `RESEND_API_KEY`, `EMAIL_FROM`                | Reports and alerts (verify the sending domain in Resend)                                                |
   | `ALERT_EMAIL`                                 | Where operational alerts go                                                                             |
   | `ALERT_WHATSAPP_*`                            | Optional: agency alerts on your own WhatsApp number (template `il_agency_alert`)                        |
   | `SENTRY_DSN`                                  | Optional error tracking (Sentry or self-hosted GlitchTip)                                               |
   | `HEARTBEAT_URL`                               | Optional dead-man's switch: pinged every 5 minutes; your uptime service alerts when it stops            |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`    | Optional Google Calendar; see [GOOGLE-CALENDAR.md](GOOGLE-CALENDAR.md)                                  |
   | `BACKUP_RCLONE_REMOTE` or `BACKUP_S3_URI`     | Where backups are copied off the machine (below)                                                        |
   | `ALLOW_FAKE_CHANNEL`, `SEED_PASSWORD`         | Leave unset in production (no sandbox, no demo tenants)                                                 |

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
git pull && deploy/deploy.sh          # builds instantlead:<commit>, migrates, swaps, waits for healthy (back up first: below)
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
- Data-destroying changes (drop table/column) are the only thing a rollback can't undo: take the manual pre-deploy backup (below) and note the restore time.

### Database: Supabase (production)

Production uses one Supabase project in **ap-south-1 (Mumbai)**, as plain Postgres: the app never uses Supabase's REST API,
Auth, Storage or Realtime. The pilot runs on the **Free plan**: no downloadable backups (your manual `pg_dump` below is the only
backup), 500 MB database, and the project pauses after a week of low database activity (the running app queries it constantly,
so this only happens if the app is down for days; Supabase emails a warning first, and a paused project can be resumed for 90 days).

**One-time setup (on your machine; nothing secret goes in chat or git):**

1. Supabase > Database > Settings: **reset the database password**. Use letters and digits only (e.g. `openssl rand -hex 24`):
   the password goes into a URL and through Docker Compose, where `$`, `@`, `:`, `/` break it.
2. Same page, **Connection pooling > Pool size: 40**. In session mode the pool size caps connections **per role and
   database**, and the owner role alone holds 12 (4 system + 8 job queue), plus about 9 more while a deploy's migrate step runs
   next to the old app; the app role holds 10. `max_connections` is 60 and Supabase itself uses about 13, so the total (about
   31 + 13) still fits.
3. Settings > API (Data API): turn it **off** (the migrator already revokes `anon`/`authenticated` and enables RLS everywhere;
   switching the API off removes the surface entirely). Turn on **SSL enforcement** (Database > Settings).
4. Supabase > Connect > **Session pooler** (port **5432**, IPv4). Never the transaction pooler (6543): the job queue and the
   migration lock need session features. The direct host is IPv6-only on Free.
5. In the VPS `.env` (chmod 600):

   ```bash
   DATABASE_OWNER_URL=postgres://postgres.<project-ref>:<db-password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=no-verify
   DATABASE_URL=postgres://instantlead_app.<project-ref>:<APP_DB_PASSWORD>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=no-verify
   ```

   Copy the exact host from the Connect dialog (it may not be `aws-0`). `<APP_DB_PASSWORD>` is a new random password (letters and
   digits) that the migrate step sets on the `instantlead_app` role. `sslmode=no-verify` encrypts without checking Supabase's CA.

6. `deploy/deploy.sh` (or the first-start commands above): the migrate container creates the job-queue schema, sets the app role's
   password, applies any migration newer than the journal and re-applies grants. Then seed the agency admin and check `/readyz`.

The schema on `instantlead-staging` was applied through Supabase's SQL tool with marker rows in `drizzle.__drizzle_migrations`
(`created_at` = each migration's journal `when`), so the migrator skips 0000–0018 and applies only later migrations.

**Scaling later:** run a second app container with `ROLE=worker` and set the web one to `ROLE=api` (mind the Supabase pool size).

## Backups and restore (manual, from your laptop)

Supabase Free keeps no backups you can download: **take a backup before every deploy and at least weekly**, on your laptop.
Use the **PostgreSQL 17 client tools** (`pg_dump` must be at least the server's major version; Supabase runs 17). On Windows: the
EDB PostgreSQL 17 installer with only "Command Line Tools" ticked, then add `C:\Program Files\PostgreSQL\17\bin` to PATH.

**Password, once:** put it in `%APPDATA%\postgresql\pgpass.conf` (Windows) or `~/.pgpass` (chmod 600), never in the repo or a script:

```
aws-0-ap-south-1.pooler.supabase.com:5432:postgres:postgres.<project-ref>:<db-password>
```

**Backup** (PowerShell; our three schemas only, not Supabase's own `auth`/`storage` schemas):

```powershell
pg_dump "host=aws-0-ap-south-1.pooler.supabase.com port=5432 dbname=postgres user=postgres.<project-ref> sslmode=require" --format=custom --no-owner --no-privileges --schema=public --schema=drizzle --schema=pgboss --extension=btree_gist --file "$HOME\instantlead-backups\instantlead-$(Get-Date -Format yyyyMMdd-HHmm).dump"
pg_restore --list "$HOME\instantlead-backups\<file>.dump" | Select-Object -First 5      # readable = usable
```

Keep the dumps on an encrypted disk (BitLocker) or in an encrypted archive: they contain patient data. They are useless without
`SECRETS_KEY` and `HASH_KEY` (password manager, stored separately).

**Restore** (into an empty Supabase project, or a local Postgres 17 for a drill; stop the app first if it is production):

1. Create the app role before restoring (row-level-security policies name it; it lives outside the dump):
   `psql "<owner connection string>" -c "create role instantlead_app login nosuperuser nobypassrls"`
2. `pg_restore --no-owner --no-privileges --dbname "<owner connection string>" <file>.dump`
   Errors about objects that already exist (e.g. schema `public`) are expected; anything else, stop and read it.
3. Point `.env` at that database and run the migrate step (`docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml run --rm migrate`):
   it sets the app role's password, re-applies grants and locks the Data API again.
4. Check: `/readyz` is ok, sign in, clinics and recent leads are there.

**Run a restore drill before go-live and every quarter.** Erased leads come back if you restore an older backup: re-run erasures
recorded in `audit_log` (`action = 'lead.erased'`) after a restore. `deploy/backup.sh`, `deploy/restore.sh` and
`deploy/restore-check.sh` work on the local Postgres container (development and the CI `docker` job), not on Supabase.

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
