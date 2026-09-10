#!/usr/bin/env python3
"""apple-dev-token.py - mint an Apple Music developer token (an ES256 JWT) on this laptop.

PocketBase's Goja runtime cannot sign ES256, so the token is minted here and shipped
as an ordinary runtime secret:

    python3 tools/apple-dev-token.py --team TEAMID --key-id KEYID --p8 ~/secure/AuthKey_KEYID.p8 \
      | platform/bin/pb-secret set cymbal-on-website.APPLE_DEVELOPER_TOKEN
    platform/bin/pb-provision cymbal-on-website --push-env

Apple caps a developer token at about six months, so this defaults to 180 days and
prints the expiry on stderr. Re-run it before then. The .p8 key never leaves this
machine and is never committed. Uses only the Python standard library plus openssl.
"""
import argparse
import base64
import json
import subprocess
import sys
import time

MAX_DAYS = 180


def b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def der_to_raw(der):
    """An ECDSA signature arrives from openssl as DER SEQUENCE { INTEGER r, INTEGER s };
    a JWT wants the two 32-byte integers concatenated."""
    if der[0] != 0x30:
        raise ValueError("not a DER sequence")
    i = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    out = b""
    for _ in range(2):
        if der[i] != 0x02:
            raise ValueError("expected a DER integer")
        length = der[i + 1]
        value = der[i + 2:i + 2 + length]
        i += 2 + length
        value = value.lstrip(bytes([0]))
        if len(value) > 32:
            raise ValueError("integer too long for P-256")
        out += value.rjust(32, bytes([0]))
    return out


def main():
    ap = argparse.ArgumentParser(description="Mint an Apple Music developer token.")
    ap.add_argument("--team", required=True, help="Apple Developer Team ID")
    ap.add_argument("--key-id", required=True, help="MusicKit key id (the KEYID in AuthKey_KEYID.p8)")
    ap.add_argument("--p8", required=True, help="path to the MusicKit private key (.p8)")
    ap.add_argument("--days", type=int, default=MAX_DAYS, help="lifetime in days (max %d)" % MAX_DAYS)
    args = ap.parse_args()
    if not 1 <= args.days <= MAX_DAYS:
        sys.exit("--days must be between 1 and %d" % MAX_DAYS)

    now = int(time.time())
    exp = now + args.days * 86400
    header = {"alg": "ES256", "kid": args.key_id, "typ": "JWT"}
    claims = {"iss": args.team, "iat": now, "exp": exp}
    signing_input = (b64url(json.dumps(header, separators=(",", ":")).encode()) + "." +
                     b64url(json.dumps(claims, separators=(",", ":")).encode()))
    proc = subprocess.run(["openssl", "dgst", "-sha256", "-sign", args.p8],
                          input=signing_input.encode("ascii"), capture_output=True, check=False)
    if proc.returncode != 0:
        sys.exit("openssl failed: " + proc.stderr.decode(errors="replace").strip())
    token = signing_input + "." + b64url(der_to_raw(proc.stdout))
    print(token)
    print("apple developer token expires %s UTC - re-mint before then"
          % time.strftime("%Y-%m-%d", time.gmtime(exp)), file=sys.stderr)


if __name__ == "__main__":
    main()
