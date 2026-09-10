#!/usr/bin/env bash
# enable-local-backups.sh [slug] — nightly PocketBase backups to the instance's own
# disk (03:00, keep 7). Run as root ON PROD:
#
#   scp tools/enable-local-backups.sh prod:/tmp/
#   ssh -t prod 'sudo bash /tmp/enable-local-backups.sh cymbal-on-website'
#
# Why this exists instead of platform/bin/pb-backups: that tool must run where the
# superuser password is (prod, /etc/pocketbase/<slug>.superuser, root 0600) and it
# needs jq, which prod does not have. This does the same PATCH with curl and the
# python3 standard library. The password is read on prod and never printed or sent
# anywhere but the instance's own loopback port.
#
# Offsite (S3/R2) backups still need the platform's _s3.* credentials and pb-backups.
set -euo pipefail

SLUG="${1:-cymbal-on-website}"
[[ "$SLUG" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || { echo "✗ bad slug '$SLUG'" >&2; exit 1; }
ENVF="/etc/pocketbase/$SLUG.env"
SUF="/etc/pocketbase/$SLUG.superuser"
[ -r "$ENVF" ] && [ -r "$SUF" ] || { echo "✗ run as root on prod ($ENVF / $SUF not readable)" >&2; exit 1; }
PORT="$(sed -n 's/^PB_PORT=//p' "$ENVF")"
[ -n "$PORT" ] || { echo "✗ no PB_PORT in $ENVF" >&2; exit 1; }

python3 - "http://127.0.0.1:$PORT" "$SUF" <<'PY'
import json
import sys
import urllib.request

base, su_file = sys.argv[1], sys.argv[2]
with open(su_file) as f:
    password = f.read().strip()


def call(method, path, body, token=None):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(), method=method,
                                 headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", token)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


token = call("POST", "/api/collections/_superusers/auth-with-password",
             {"identity": "admin@solhann.net", "password": password})["token"]
settings = call("PATCH", "/api/settings",
                {"backups": {"cron": "0 3 * * *", "cronMaxKeep": 7, "s3": {"enabled": False}}}, token)
b = settings["backups"]
print("✓ backups: cron=%s keep=%s s3=%s" % (b["cron"], b["cronMaxKeep"], b["s3"]["enabled"]))
PY
