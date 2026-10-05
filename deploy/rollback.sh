#!/usr/bin/env bash
# Roll the app back to the previous release (or a given tag):   deploy/rollback.sh [tag]
# The database is NOT rolled back: migrations are written so the previous release still works on the new
# schema (OPERATIONS.md, "Zero-downtime migrations"). If a release really needs its data undone, restore a
# backup instead (docs/OPERATIONS.md, Backups and restore).
set -euo pipefail
cd "$(dirname "$0")/.."
COMPOSE=(docker compose -f docker-compose.yml -f deploy/docker-compose.prod.yml)
TAG="${1:-$(cat .deploy/previous 2>/dev/null || true)}"
[ -n "$TAG" ] || { echo "no previous release recorded; pass a tag (docker images instantlead)" >&2; exit 1; }
docker image inspect "instantlead:$TAG" >/dev/null 2>&1 || { echo "image instantlead:$TAG is not on this machine" >&2; exit 1; }
echo "==> rolling back to instantlead:$TAG"
IMAGE_TAG="$TAG" "${COMPOSE[@]}" up -d --no-deps app
cat .deploy/current > .deploy/previous 2>/dev/null || true
echo "$TAG" > .deploy/current
