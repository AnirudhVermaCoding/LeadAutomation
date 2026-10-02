#!/usr/bin/env bash
# Nightly (cron) or before a deploy:   deploy/backup.sh [--label name]
#
# Writes a compressed logical dump (pg_dump -Fc), optionally encrypts it, copies it OFF the machine, and
# prunes old local copies. Off-site is the part that saves you when the VPS is lost: configure one of
#   BACKUP_RCLONE_REMOTE=remote:bucket/path     (rclone: S3, Backblaze B2, Wasabi, Google Drive…)
#   BACKUP_S3_URI=s3://bucket/path              (aws cli with credentials in the environment)
# in .env. Without either, the dump stays local and the script says so (exit 0: a local copy beats none).
#
# Optional BACKUP_GPG_PASSPHRASE_FILE=/path  encrypts the dump (gpg --symmetric). It contains customer
# data; encrypt whenever it leaves the machine. SECRETS_KEY (which decrypts stored credentials) is NOT in
# the dump: keep it in your password manager.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

LABEL="nightly"
[ "${1:-}" = "--label" ] && LABEL="${2:?label}"
DIR="${BACKUP_DIR:-/var/backups/instantlead}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
read -ra COMPOSE <<< "docker compose ${COMPOSE_FILES:--f docker-compose.yml -f deploy/docker-compose.prod.yml}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$DIR/instantlead-$LABEL-$STAMP.dump"
mkdir -p "$DIR"

echo "==> dumping to $FILE"
"${COMPOSE[@]}" exec -T db pg_dump -U instantlead -Fc --no-owner instantlead > "$FILE"
[ -s "$FILE" ] || { echo "!! empty dump" >&2; rm -f "$FILE"; exit 1; }

# A dump we cannot read back is not a backup: list its contents as a cheap integrity check.
"${COMPOSE[@]}" exec -T db pg_restore -l < "$FILE" > /dev/null || { echo "!! the dump is unreadable" >&2; exit 1; }

if [ -n "${BACKUP_GPG_PASSPHRASE_FILE:-}" ]; then
  gpg --batch --yes --pinentry-mode loopback --passphrase-file "$BACKUP_GPG_PASSPHRASE_FILE" --symmetric --cipher-algo AES256 -o "$FILE.gpg" "$FILE"
  rm -f "$FILE"
  FILE="$FILE.gpg"
fi

if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  echo "==> copying off-site (rclone: $BACKUP_RCLONE_REMOTE)"
  rclone copyto "$FILE" "$BACKUP_RCLONE_REMOTE/$(basename "$FILE")"
elif [ -n "${BACKUP_S3_URI:-}" ]; then
  echo "==> copying off-site (S3: $BACKUP_S3_URI)"
  aws s3 cp "$FILE" "$BACKUP_S3_URI/$(basename "$FILE")"
else
  echo "!! no off-site destination configured (BACKUP_RCLONE_REMOTE or BACKUP_S3_URI): this backup is only on this machine" >&2
fi

find "$DIR" -name 'instantlead-*.dump*' -mtime "+$KEEP_DAYS" -delete
echo "==> done: $FILE"
