#!/usr/bin/env bash
# One-command deploy on the VPS:   deploy/deploy.sh           (from the repo root, after `git pull`)
#
#   1. builds an image tagged with the git commit,
#   2. runs the migrations (against Supabase, from .env) as a one-off container while the OLD app keeps serving,
#   3. swaps the app container (a few seconds; Caddy holds requests meanwhile),
#   4. waits for the new app to report healthy, and rolls back to the previous image if it does not.
#
# Migrations must be backward compatible with the previous release (add before you remove): see OPERATIONS.md
# "Zero-downtime migrations". That is what makes step 4's rollback safe.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml)
STATE=.deploy
mkdir -p "$STATE"

NEW_TAG="${IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"
PREVIOUS_TAG="$(cat "$STATE/current" 2>/dev/null || true)"

echo "==> building instantlead:$NEW_TAG"
IMAGE_TAG="$NEW_TAG" "${COMPOSE[@]}" build migrate

# The database is Supabase Free (no automatic backups): take the manual pg_dump in docs/OPERATIONS.md first.
echo "==> reminder: back up the Supabase database before deploying (docs/OPERATIONS.md, Backups)"

echo "==> migrating (old app still serving)"
IMAGE_TAG="$NEW_TAG" "${COMPOSE[@]}" run --rm migrate

echo "==> swapping the app container"
IMAGE_TAG="$NEW_TAG" "${COMPOSE[@]}" up -d --no-deps app caddy

echo "==> waiting for the new app to be healthy"
for _ in $(seq 1 40); do
  status="$("${COMPOSE[@]}" ps --format '{{.Health}}' app 2>/dev/null || true)"
  if [ "$status" = "healthy" ]; then
    echo "$NEW_TAG" > "$STATE/current"
    [ -n "$PREVIOUS_TAG" ] && echo "$PREVIOUS_TAG" > "$STATE/previous"
    echo "==> deployed $NEW_TAG (previous: ${PREVIOUS_TAG:-none})"
    exit 0
  fi
  sleep 3
done

echo "!! the new app did not become healthy" >&2
if [ -n "$PREVIOUS_TAG" ]; then
  echo "==> rolling back to $PREVIOUS_TAG" >&2
  IMAGE_TAG="$PREVIOUS_TAG" "${COMPOSE[@]}" up -d --no-deps app
fi
exit 1
