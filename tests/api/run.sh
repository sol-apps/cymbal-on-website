#!/usr/bin/env bash
# tests/api/run.sh — Cymbal end to end, against a throwaway local PocketBase.
#
# Starts tests/api/mock.py (every provider) and a PocketBase in LOCAL identity mode
# on spare ports, with this checkout's hooks and migrations and a data dir that is
# deleted afterwards. Nothing here touches prod, pb-secret or a real provider.
#
#   bash tests/api/run.sh            PORT / MOCK_PORT / PB_BIN override the defaults
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."
PB_BIN="${PB_BIN:-$HOME/.local/bin/pocketbase}"
PORT="${PORT:-8097}"
MOCK_PORT="${MOCK_PORT:-8098}"
[ -x "$PB_BIN" ] || { echo "✗ no pocketbase at $PB_BIN (run platform/bin/pb-dev once to install it)" >&2; exit 1; }

WORK="$(mktemp -d)"
PB_PID=""
MOCK_PID=""
cleanup() {
  [ -n "$PB_PID" ] && kill "$PB_PID" 2>/dev/null || true
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

python3 tests/api/mock.py --port "$MOCK_PORT" >"$WORK/mock.log" 2>&1 &
MOCK_PID=$!

SU_EMAIL="tests@cymbal.invalid"
SU_PASS="$(openssl rand -hex 12)"
GREENLIGHT_IDENTITY_MODE=local "$PB_BIN" superuser upsert "$SU_EMAIL" "$SU_PASS" --dir "$WORK/pb_data" >/dev/null

env GREENLIGHT_IDENTITY_MODE=local \
    CYMBAL_TOKEN_KEY=0123456789abcdef0123456789abcdef \
    CYMBAL_MOCK_BASE="http://127.0.0.1:$MOCK_PORT" \
    CYMBAL_PUBLIC_URL="http://127.0.0.1:$PORT" \
    SPOTIFY_CLIENT_ID=test-spotify SPOTIFY_CLIENT_SECRET=test-secret \
    GOOGLE_CLIENT_ID=test-google GOOGLE_CLIENT_SECRET=test-secret \
    APPLE_DEVELOPER_TOKEN=test-apple-token \
    CYMBAL_SPOTIFY_METADATA_TRANSFER=allowed \
    CYMBAL_CONTACT=tests@cymbal.invalid \
  "$PB_BIN" serve --dir="$WORK/pb_data" --publicDir=. --hooksDir=pb_hooks \
    --migrationsDir=pb_migrations --http="127.0.0.1:$PORT" >"$WORK/pb.log" 2>&1 &
PB_PID=$!

for _ in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  echo "✗ pocketbase did not come up" >&2
  cat "$WORK/pb.log" >&2
  exit 1
fi

status=0
PB_URL="http://127.0.0.1:$PORT" MOCK_URL="http://127.0.0.1:$MOCK_PORT" SU_EMAIL="$SU_EMAIL" SU_PASS="$SU_PASS" \
  node --test --test-concurrency=1 tests/api/ || status=$?

if [ "$status" != 0 ]; then
  echo "── pocketbase log (tail) ──" >&2
  tail -n 60 "$WORK/pb.log" >&2
fi
exit "$status"
