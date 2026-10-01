# Operations

## Deploy (single VPS in India, Docker + Caddy)

One small VM runs everything: Postgres, the app (HTTP + workers) and Caddy for HTTPS.
2 vCPU / 4 GB is plenty for dozens of clinics. Pick an Indian region (AWS `ap-south-1` Mumbai,
GCP `asia-south1`, DigitalOcean BLR1, Azure Central India) so patient data stays in India.

1. Ubuntu 24.04 LTS, Docker Engine + Compose plugin, firewall open only for 22, 80, 443.
2. DNS: an A record for your domain (e.g. `app.example.in`) pointing at the VM.
3. `git clone` the repo, then `cp .env.example .env` and set **real** values:

   | Variable                                      | Value                                                                                              |
   | --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
   | `NODE_ENV`                                    | `production` (refuses the `dev-only…` secrets from `.env.example`)                                 |
   | `APP_URL`                                     | `https://app.example.in`                                                                           |
   | `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`        | `openssl rand -hex 24` each; update both `DATABASE_*_URL`s to match                                |
   | `BETTER_AUTH_SECRET`                          | `openssl rand -base64 48`                                                                          |
   | `SECRETS_KEY`                                 | `openssl rand -base64 32`; **back it up offline**, encrypted credentials are unreadable without it |
   | `HASH_KEY`                                    | Set to the same value as `SECRETS_KEY` and never change it (keys the opt-out list)                 |
   | `AGENCY_ADMIN_EMAIL`, `AGENCY_ADMIN_PASSWORD` | The first agency login                                                                             |
   | `META_APP_SECRET`, `META_VERIFY_TOKEN`        | From the Meta app; the verify token is any random string you also enter in Meta                    |
   | `ANTHROPIC_API_KEY`                           | Claude for the assistant (without it the rule-based fallback answers)                              |
   | `RESEND_API_KEY`, `EMAIL_FROM`                | Reports and alerts (verify the sending domain in Resend)                                           |
   | `ALERT_EMAIL`                                 | Where operational alerts go                                                                        |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`    | Optional Google Calendar sync; redirect URI `https://<domain>/v1/integrations/google/callback`     |
   | `ALLOW_FAKE_CHANNEL`                          | Leave unset (off in production; the sandbox and dev endpoints disappear)                           |
   | `SEED_PASSWORD`                               | Leave unset in production (no demo tenants)                                                        |

4. Put your domain in `deploy/Caddyfile`, then:

   ```bash
   docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build
   docker compose exec app node apps/api/src/system/seed.ts   # creates the agency admin
   ```

   Migrations run automatically on every app start. Caddy gets and renews the TLS certificate, and the app port
   is not exposed directly (`TRUST_PROXY=true` so rate limits see real client IPs).

5. Check `https://<domain>/readyz` returns `{"ok":true}`, sign in, then onboard clients ([ONBOARDING.md](ONBOARDING.md)).

**Update:** `git pull && docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml up -d --build`.
Jobs survive restarts (they live in Postgres); in-flight ones are retried.

**Scaling later:** run a second app container with `ROLE=worker` and set the web one to `ROLE=api`; move Postgres to a managed
instance in the same region. Nothing else changes.

## Backups and restore

Nightly logical backup, kept 14 days, with a copy off the VM (e.g. an S3 bucket in `ap-south-1` with versioning):

```bash
# /etc/cron.d/instantlead-backup
15 3 * * * root cd /opt/instantlead && docker compose exec -T db pg_dump -U instantlead -Fc instantlead > /var/backups/instantlead-$(date +\%F).dump && find /var/backups -name 'instantlead-*.dump' -mtime +14 -delete
```

Restore (to a fresh database, app stopped):

```bash
docker compose stop app
docker compose exec -T db dropdb -U instantlead instantlead
docker compose exec -T db createdb -U instantlead instantlead
docker compose exec -T db pg_restore -U instantlead -d instantlead --no-owner < /var/backups/instantlead-YYYY-MM-DD.dump
docker compose start app   # re-creates the app role and grants
```

The backup is useless without `SECRETS_KEY` and `HASH_KEY`; store them separately (password manager). **Test a restore every quarter.**
Erased leads come back if you restore an older backup; re-run erasures recorded in `audit_log` (`action = 'lead.erased'`) after a restore.

## Monitoring

- **Health endpoints:** `/healthz` (process up) and `/readyz` (database reachable) for an uptime checker (UptimeRobot, Better Stack), every minute.
- **Built-in monitor** (every 5 minutes) emails `ALERT_EMAIL` about: repeated failed WhatsApp sends, AI errors, no delivery receipts for sent messages (the Meta webhook is probably broken), job backlog, dead-lettered jobs. Alerts are deduped and repeat at most every 6 hours while the problem lasts.
- **Agency → Monitoring:** recent alerts and dead-lettered jobs; **Run checks now** triggers the monitor.
- **Per clinic:** Settings → Integrations → Health (last send, last delivery receipt, last inbound message, failures in 24 h).
- **Logs:** `docker compose logs -f app` (JSON, personal data redacted). Every job logs `job done` or a failure.

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
everywhere, unset `ANTHROPIC_API_KEY` and restart; the rule-based assistant takes over.

### Incident: personal data breach

1. Contain: revoke the leaked credential, rotate secrets (above), lock affected accounts.
2. Record it at once in the breach register (`POST /v1/admin/breaches` as agency admin): detection time, description, clinic, people affected.
3. Tell the affected clinic(s) immediately; as Data Fiduciary they notify affected people.
4. Notify the Data Protection Board without delay, with a detailed report within 72 hours (DPDP Rules); update the register with `reportedToBoardAt` and `usersNotifiedAt`.
5. Write up the root cause and fix.
