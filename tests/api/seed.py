#!/usr/bin/env python3
"""tests/api/seed.py - fill a LOCAL dev Cymbal (tests/api/dev.sh) with posts, comments
and connected mock providers, so the page can be looked at.

Posting needs no account: each seeded person is a name, a browser key and an address.
Local identity mode has no identity provider, so the owner's session is a
superuser-impersonated token, written to the file named on the command line.
Nothing here can reach prod: it only talks to PB_URL, which dev.sh points at 127.0.0.1.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ["PB_URL"]
OUT = sys.argv[1]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def call(method, path, token=None, body=None, key=None, ip=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if token:
        req.add_header("Authorization", token)
    if key:
        req.add_header("X-Cymbal-Key", key)
    if ip:
        req.add_header("CF-Connecting-IP", ip)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with OPENER.open(req) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None), r.headers
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            parsed = json.loads(raw) if raw else None
        except ValueError:
            parsed = None
        return e.code, parsed, e.headers


def must(result, what):
    status, body, _ = result
    if status >= 300:
        raise SystemExit("%s failed: %s %s" % (what, status, body))
    return body


su = must(call("POST", "/api/collections/_superusers/auth-with-password",
               body={"identity": os.environ["SU_EMAIL"], "password": os.environ["SU_PASS"]}), "superuser")["token"]

pw = os.urandom(12).hex()
rec = must(call("POST", "/api/collections/users/records", su,
                {"email": "owner@cymbal.invalid", "password": pw, "passwordConfirm": pw, "name": "Sol", "role": "admin"}), "owner")
tok = must(call("POST", "/api/collections/users/impersonate/" + rec["id"], su, {"duration": 86400}), "impersonate")
owner_token = tok["token"]

people = {
    "owner": {"name": "Sol", "key": os.urandom(24).hex(), "ip": "198.51.100.1"},
    "ann": {"name": "Ann", "key": os.urandom(24).hex(), "ip": "198.51.100.2"},
    "ben": {"name": "Ben", "key": os.urandom(24).hex(), "ip": "198.51.100.3"},
}


def post(who, url, caption):
    p = people[who]
    return must(call("POST", "/api/cymbal/posts", body={"url": url, "name": p["name"], "caption": caption,
                                                        "request_id": os.urandom(8).hex()}, key=p["key"], ip=p["ip"]), "post")["post"]


def comment(who, post_id, text):
    p = people[who]
    must(call("POST", "/api/cymbal/posts/%s/comments" % post_id, body={"body": text, "name": p["name"],
                                                                        "request_id": os.urandom(8).hex()}, key=p["key"], ip=p["ip"]), "comment")


for provider in ("spotify", "youtube"):
    start = must(call("POST", "/api/cymbal/owner/oauth/%s/start" % provider, owner_token, {}), "oauth start")
    state = urllib.parse.parse_qs(urllib.parse.urlparse(start["url"]).query)["state"][0]
    status, _, headers = call("GET", "/api/cymbal/oauth/%s/callback?code=good-code&state=%s" % (provider, state))
    print(provider, status, headers.get("Location"))
    must(call("POST", "/api/cymbal/owner/providers/%s/playlist" % provider, owner_token, {}), "playlist " + provider)
must(call("POST", "/api/cymbal/owner/apple/playlist", owner_token, {"library_id": "p.DevLibrary1"}), "apple playlist")

a = post("ann", "https://open.spotify.com/track/4u7EnebtmKWzUH433cf5Qv?si=dev", "This never gets old. Headphones on, volume up, operatic section at full blast.")
b = post("ben", "https://youtu.be/dQw4w9WgXcQ", "Sorry. Not sorry.")
post("owner", "https://open.spotify.com/track/Ambiguous0000000000001", "Which version is this one?")
post("ann", "https://open.spotify.com/track/LiveSong00000000000001", "Live beats studio, fight me")
post("ben", "https://music.apple.com/gb/song/song-c/1000000003", "")
comment("ben", a["id"], "Absolute tune.")
comment("owner", a["id"], "Certified.")
comment("ann", b["id"], "How dare you")

for _ in range(3):
    print(call("POST", "/api/cymbal/owner/sync/run", owner_token, {})[1])
    time.sleep(6)

with open(OUT, "w") as f:
    json.dump({"owner_token": owner_token, "owner_record": tok["record"], "people": people}, f)
print("seeded; owner token and browser keys in", OUT)
