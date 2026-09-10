#!/usr/bin/env bash
# tests/api/dev.sh — a local Cymbal to look at: the provider mock, a LOCAL-mode
# PocketBase with this checkout's hooks and migrations, and seeded people and posts
# (tests/api/seed.py). Nothing here touches prod, pb-secret or a real provider.
#
#   bash tests/api/dev.sh     then open http://127.0.0.1:8099 — sign-in tokens for the
#                             seeded people are in $CYMBAL_DEV_DIR/tokens.json
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PB_BIN="${PB_BIN:-$HOME/.local/bin/pocketbase}"
PORT="${PORT:-8099}"
MOCK_PORT="${MOCK_PORT:-8100}"
DIR="${CYMBAL_DEV_DIR:-${TMPDIR:-/tmp}/cymbal-dev}"

rm -rf "$DIR"
mkdir -p "$DIR"

python3 tests/api/mock.py --port "$MOCK_PORT" >"$DIR/mock.log" 2>&1 &
MOCK_PID=$!
trap 'kill "$MOCK_PID" 2>/dev/null || true' EXIT INT TERM

SU_EMAIL="dev@cymbal.invalid"
SU_PASS="$(openssl rand -hex 12)"
GREENLIGHT_IDENTITY_MODE=local "$PB_BIN" superuser upsert "$SU_EMAIL" "$SU_PASS" --dir "$DIR/pb_data" >/dev/null

(
  for _ in $(seq 1 40); do
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
    sleep 0.5
  done
  PB_URL="http://127.0.0.1:$PORT" SU_EMAIL="$SU_EMAIL" SU_PASS="$SU_PASS" \
    python3 tests/api/seed.py "$DIR/tokens.json" >"$DIR/seed.log" 2>&1 \
    || echo "seed failed: see $DIR/seed.log" >&2
) &

env GREENLIGHT_IDENTITY_MODE=local \
    CYMBAL_TOKEN_KEY=0123456789abcdef0123456789abcdef \
    CYMBAL_MOCK_BASE="http://127.0.0.1:$MOCK_PORT" \
    CYMBAL_PUBLIC_URL="http://127.0.0.1:$PORT" \
    SPOTIFY_CLIENT_ID=test-spotify SPOTIFY_CLIENT_SECRET=test-secret \
    GOOGLE_CLIENT_ID=test-google GOOGLE_CLIENT_SECRET=test-secret \
    APPLE_DEVELOPER_TOKEN=test-apple-token \
    CYMBAL_SPOTIFY_METADATA_TRANSFER=allowed \
  "$PB_BIN" serve --dir="$DIR/pb_data" --publicDir=. --hooksDir=pb_hooks \
    --migrationsDir=pb_migrations --http="127.0.0.1:$PORT"
