#!/usr/bin/env bash
# Local Postgres container only (development, CI). Production is Supabase: see docs/OPERATIONS.md, Backups.
# Restore a dump into a database:   deploy/restore.sh <file.dump[.gpg]> [target_db]
#
# Default target is a SCRATCH database `instantlead_restore` (safe: look around, run restore-check.sh,
# then decide). To replace production: stop the app, `deploy/restore.sh file instantlead --replace`, start the app.
#
# What a bare pg_restore would lose: the app's database role and its grants live in the cluster, not in the
# dump, and the row-level-security policies reference that role. So this script creates the role first and
# re-applies grants afterwards (the same migrate step the app runs), then verifies RLS survived.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

FILE="${1:?usage: deploy/restore.sh <dump> [target_db] [--replace]}"
TARGET="${2:-instantlead_restore}"
REPLACE="${3:-}"
read -ra COMPOSE <<< "docker compose ${COMPOSE_FILES:--f docker-compose.yml}"
PSQL=("${COMPOSE[@]}" exec -T db psql -U instantlead -v ON_ERROR_STOP=1 -d postgres)
APP_PW="${APP_DB_PASSWORD:-app_dev_pw}"

if [ "$TARGET" = "instantlead" ] && [ "$REPLACE" != "--replace" ]; then
  echo "refusing to overwrite the live database without --replace (and stop the app first)" >&2
  exit 1
fi

IN="$FILE"
if [[ "$FILE" == *.gpg ]]; then
  IN="$(mktemp)"
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "${BACKUP_GPG_PASSPHRASE_FILE:?set BACKUP_GPG_PASSPHRASE_FILE}" -o "$IN" -d "$FILE"
fi

echo "==> creating database $TARGET and the app role"
"${PSQL[@]}" -c "DROP DATABASE IF EXISTS \"$TARGET\"" -c "CREATE DATABASE \"$TARGET\""
"${PSQL[@]}" -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'instantlead_app') THEN CREATE ROLE instantlead_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '$APP_PW'; END IF; END \$\$"

echo "==> restoring"
"${COMPOSE[@]}" exec -T db pg_restore -U instantlead -d "$TARGET" --no-owner --exit-on-error < "$IN"
[ "$IN" != "$FILE" ] && rm -f "$IN"

echo "==> re-applying grants, queues and template rows (the app's own migrate step)"
"${COMPOSE[@]}" run --rm \
  -e "DATABASE_OWNER_URL=postgres://instantlead:${POSTGRES_PASSWORD:-instantlead_dev}@db:5432/$TARGET" \
  -e "DATABASE_URL=postgres://instantlead_app:${APP_PW}@db:5432/$TARGET" \
  migrate

echo "==> verifying"
deploy/restore-check.sh "$TARGET"
