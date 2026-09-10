#!/usr/bin/env python3
"""tests/api/mock.py - one local stand-in for every provider Cymbal talks to.

Paths are prefixed with the lib/util.js BASES key they replace:
  /spotify_api  /spotify_accounts  /youtube_api  /google_token  /google_auth
  /apple_api    /musicbrainz       /itunes
Only a PocketBase in LOCAL identity mode with CYMBAL_MOCK_BASE set is sent here.

Test control:
  POST /__control {"once": {k: v}, "set": {k: v}, "clear": [k]}   inject faults
  POST /__reset                                                   forget everything
  GET  /__log                                                     requests received
  GET  /__state                                                   playlists and add counts
Faults: spotify_add = "429" | "500_after_apply"; youtube_insert = "429" | "quota";
        spotify_refresh = "invalid_grant"; apple_search = "503".
"""
import argparse
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

SPOTIFY = {
    "4u7EnebtmKWzUH433cf5Qv": {"name": "Bohemian Rhapsody", "artists": ["Queen"], "duration_ms": 354320,
                               "isrc": "GBUM71029604", "album_type": "album", "release_date": "1975-11-21"},
    "4uLU6hMCjMI75M1A2tKUQC": {"name": "Never Gonna Give You Up", "artists": ["Rick Astley"], "duration_ms": 213573,
                               "isrc": "GBARL9300135", "album_type": "album", "release_date": "1987-11-12"},
    "Ambiguous0000000000001": {"name": "Echo Chamber", "artists": ["Echo"], "duration_ms": 200000, "isrc": "USAAA2400001"},
    "LiveSong00000000000001": {"name": "Song C - Live", "artists": ["Band"], "duration_ms": 250000, "isrc": "USBBB2400001"},
    "Uncertain0000000000001": {"name": "Maybe Song", "artists": ["Quiet"], "duration_ms": 180000, "isrc": "USFFF2400001"},
}

APPLE = {
    "1440650711": {"name": "Bohemian Rhapsody", "artistName": "Queen", "durationInMillis": 354947,
                   "isrc": "GBUM71029604", "albumName": "A Night at the Opera"},
    "1558533900": {"name": "Never Gonna Give You Up", "artistName": "Rick Astley", "durationInMillis": 213573,
                   "isrc": "GBARL9300135", "albumName": "Whenever You Need Somebody"},
    "1000000001": {"name": "Echo Chamber", "artistName": "Echo", "durationInMillis": 200500, "isrc": "USCCC2400001", "albumName": "One"},
    "1000000002": {"name": "Echo Chamber", "artistName": "Echo", "durationInMillis": 199800, "isrc": "USDDD2400001", "albumName": "Two"},
    "1000000003": {"name": "Song C", "artistName": "Band", "durationInMillis": 250500, "isrc": "USEEE2400001", "albumName": "Studio"},
}

YOUTUBE = {
    "fJ9rUzIMcZQ": {"title": "Bohemian Rhapsody", "channel": "Queen - Topic", "duration": "PT5M55S", "licensed": True,
                    "description": "Provided to YouTube by EMI\n\nBohemian Rhapsody · Queen\n\nA Night at the Opera",
                    "key": "bohemian rhapsody"},
    "vevoQueen01": {"title": "Queen – Bohemian Rhapsody (Official Video)", "channel": "QueenVEVO", "duration": "PT5M59S",
                    "licensed": True, "description": "", "key": "bohemian rhapsody"},
    "dQw4w9WgXcQ": {"title": "Rick Astley - Never Gonna Give You Up (Official Video)", "channel": "Rick Astley",
                    "duration": "PT3M33S", "licensed": True, "description": "", "key": "never gonna give you up"},
    "SongCstudio": {"title": "Song C", "channel": "Band - Topic", "duration": "PT4M10S", "licensed": True,
                    "description": "", "key": "song c"},
    "rateLimited": {"title": "Limit - Rate Song (Official Audio)", "channel": "Limit", "duration": "PT3M0S",
                    "licensed": True, "description": "", "key": "rate song"},
    "quotaVideo1": {"title": "Limit - Quota Song", "channel": "Limit", "duration": "PT3M5S",
                    "licensed": True, "description": "", "key": "quota song"},
}

MB_URLS = {"https://www.youtube.com/watch?v=dQw4w9WgXcQ": ["mbid-rick"]}
MB_RECORDINGS = {
    "mbid-rick": {"id": "mbid-rick", "title": "Never Gonna Give You Up", "length": 213000,
                  "isrcs": ["GBARL9300135"], "artist-credit": [{"name": "Rick Astley"}], "relations": []},
}

LOCK = threading.Lock()


def fresh_state():
    return {"log": [], "once": {}, "set": {}, "playlists": {"spotify": {}, "youtube": {}},
            "adds": {"spotify": {}, "youtube": {}}}


STATE = fresh_state()


def sp_track(tid):
    t = SPOTIFY[tid]
    return {"id": tid, "name": t["name"], "artists": [{"name": a} for a in t["artists"]],
            "duration_ms": t["duration_ms"], "external_ids": {"isrc": t["isrc"]},
            "album": {"album_type": t.get("album_type", "album"), "release_date": t.get("release_date", "2000")},
            "is_local": False, "uri": "spotify:track:" + tid}


def ap_song(sid):
    s = APPLE[sid]
    attrs = dict(s)
    attrs["url"] = "https://music.apple.com/gb/song/" + sid
    return {"id": sid, "type": "songs", "attributes": attrs}


def yt_video(vid):
    v = YOUTUBE[vid]
    return {"id": vid,
            "snippet": {"title": v["title"], "channelTitle": v["channel"], "description": v["description"],
                        "categoryId": "10", "liveBroadcastContent": "none"},
            "contentDetails": {"duration": v["duration"], "licensedContent": v["licensed"]},
            "status": {"privacyStatus": "public", "uploadStatus": "processed"}}


def form(raw):
    return {k: v[0] for k, v in parse_qs(raw, keep_blank_values=True).items()}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, code, obj=None, headers=None):
        body = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def nope(self, *args):
        self.reply(404, {"error": {"status": 404, "message": "mock: no such route"}})

    def fault(self, key):
        with LOCK:
            if key in STATE["once"]:
                return STATE["once"].pop(key)
            return STATE["set"].get(key)

    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def dispatch(self, method):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query, keep_blank_values=True).items()}
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode() if n else ""
        if not u.path.startswith("/__"):
            with LOCK:
                STATE["log"].append({"t": time.time(), "method": method, "path": u.path, "query": q,
                                     "ua": self.headers.get("User-Agent", "")})
        try:
            self.route(method, u.path, q, raw)
        except Exception as exc:  # a mock bug should look like a provider 500, loudly
            self.reply(500, {"error": {"status": 500, "message": "mock crashed: %s" % exc}})

    def route(self, method, path, q, raw):
        global STATE
        if path == "/__reset":
            with LOCK:
                STATE = fresh_state()
            return self.reply(200, {"ok": True})
        if path == "/__control":
            body = json.loads(raw or "{}")
            with LOCK:
                STATE["once"].update(body.get("once", {}))
                STATE["set"].update(body.get("set", {}))
                for k in body.get("clear", []):
                    STATE["once"].pop(k, None)
                    STATE["set"].pop(k, None)
            return self.reply(200, {"ok": True})
        if path == "/__log":
            with LOCK:
                return self.reply(200, {"log": list(STATE["log"])})
        if path == "/__state":
            with LOCK:
                return self.reply(200, {"playlists": {k: {p: list(v) for p, v in d.items()} for k, d in STATE["playlists"].items()},
                                        "adds": json.loads(json.dumps(STATE["adds"]))})
        svc, _, rest = path.lstrip("/").partition("/")
        getattr(self, "svc_" + svc, self.nope)(method, "/" + rest, q, raw)

    # ── Spotify ────────────────────────────────────────────────────────────
    def svc_spotify_accounts(self, method, rest, q, raw):
        if rest != "/api/token" or method != "POST":
            return self.nope()
        if not self.headers.get("Authorization", "").startswith("Basic "):
            return self.reply(400, {"error": "invalid_client"})
        f = form(raw)
        gt = f.get("grant_type")
        if gt == "client_credentials":
            return self.reply(200, {"access_token": "sp-app", "token_type": "Bearer", "expires_in": 3600})
        if gt == "authorization_code":
            if f.get("code") != "good-code":
                return self.reply(400, {"error": "invalid_grant"})
            return self.reply(200, {"access_token": "sp-user-1", "refresh_token": "sp-refresh", "expires_in": 3600,
                                    "scope": "playlist-modify-public playlist-read-private"})
        if gt == "refresh_token":
            if self.fault("spotify_refresh") == "invalid_grant":
                return self.reply(400, {"error": "invalid_grant", "error_description": "Refresh token revoked"})
            return self.reply(200, {"access_token": "sp-user-2", "expires_in": 3600})
        return self.reply(400, {"error": "unsupported_grant_type"})

    def svc_spotify_api(self, method, rest, q, raw):
        if not self.headers.get("Authorization", "").startswith("Bearer sp-"):
            return self.reply(401, {"error": {"status": 401, "message": "No token provided"}})
        m = re.match(r"^/tracks/([A-Za-z0-9]+)$", rest)
        if m and method == "GET":
            tid = m.group(1)
            if tid not in SPOTIFY:
                return self.reply(404, {"error": {"status": 404, "message": "Resource not found"}})
            return self.reply(200, sp_track(tid))
        if rest == "/search":
            qq = q.get("q", "")
            if qq.startswith("isrc:"):
                items = [sp_track(t) for t, v in SPOTIFY.items() if v["isrc"] == qq[5:]]
            else:
                mt = re.search(r'track:"([^"]*)"', qq)
                title = (mt.group(1) if mt else qq).lower()
                items = [sp_track(t) for t, v in SPOTIFY.items()
                         if v["name"].lower().startswith(title) or title.startswith(v["name"].lower())]
            return self.reply(200, {"tracks": {"items": items[: int(q.get("limit", "10"))]}})
        if rest == "/me":
            return self.reply(200, {"id": "owner", "display_name": "Owner Test"})
        if rest == "/me/playlists" and method == "POST":
            with LOCK:
                STATE["playlists"]["spotify"].setdefault("spPlaylist1", [])
            return self.reply(201, {"id": "spPlaylist1",
                                    "external_urls": {"spotify": "https://open.spotify.com/playlist/spPlaylist1"}})
        m = re.match(r"^/playlists/([A-Za-z0-9]+)/items$", rest)
        if m:
            pid = m.group(1)
            if method == "GET":
                with LOCK:
                    items = list(STATE["playlists"]["spotify"].get(pid, []))
                off = int(q.get("offset", "0"))
                lim = int(q.get("limit", "50"))
                page = items[off:off + lim]
                return self.reply(200, {"items": [{"track": {"id": i}} for i in page],
                                        "next": "more" if off + lim < len(items) else None})
            f = self.fault("spotify_add")
            if f == "429":
                return self.reply(429, {"error": {"status": 429, "message": "API rate limit exceeded"}}, {"Retry-After": "120"})
            uris = json.loads(raw or "{}").get("uris", [])
            with LOCK:
                for uri in uris:
                    tid = uri.split(":")[-1]
                    STATE["playlists"]["spotify"].setdefault(pid, []).append(tid)
                    STATE["adds"]["spotify"][tid] = STATE["adds"]["spotify"].get(tid, 0) + 1
            if f == "500_after_apply":
                return self.reply(500, {"error": {"status": 500, "message": "Server error"}})
            return self.reply(201, {"snapshot_id": "snap"})
        return self.nope()

    # ── Google / YouTube ───────────────────────────────────────────────────
    def svc_google_token(self, method, rest, q, raw):
        if rest != "/token" or method != "POST":
            return self.nope()
        f = form(raw)
        if f.get("client_id") != "test-google" or not f.get("client_secret"):
            return self.reply(401, {"error": "invalid_client"})
        gt = f.get("grant_type")
        if gt == "authorization_code":
            if f.get("code") != "good-code":
                return self.reply(400, {"error": "invalid_grant"})
            return self.reply(200, {"access_token": "yt-user-1", "refresh_token": "yt-refresh", "expires_in": 3599,
                                    "scope": "https://www.googleapis.com/auth/youtube"})
        if gt == "refresh_token":
            if self.fault("youtube_refresh") == "invalid_grant":
                return self.reply(400, {"error": "invalid_grant"})
            return self.reply(200, {"access_token": "yt-user-2", "expires_in": 3599})
        return self.reply(400, {"error": "unsupported_grant_type"})

    def svc_youtube_api(self, method, rest, q, raw):
        if not (self.headers.get("Authorization", "").startswith("Bearer yt-") or q.get("key")):
            return self.reply(401, {"error": {"code": 401, "errors": [{"reason": "authError"}], "message": "Login Required"}})
        if rest == "/videos":
            ids = [i for i in q.get("id", "").split(",") if i]
            return self.reply(200, {"items": [yt_video(i) for i in ids if i in YOUTUBE]})
        if rest == "/search":
            qq = q.get("q", "").lower()
            return self.reply(200, {"items": [{"id": {"kind": "youtube#video", "videoId": v}}
                                              for v, d in YOUTUBE.items() if d["key"] in qq]})
        if rest == "/channels":
            return self.reply(200, {"items": [{"snippet": {"title": "Owner Channel"}}]})
        if rest == "/playlists" and method == "POST":
            with LOCK:
                STATE["playlists"]["youtube"].setdefault("ytPlaylist1", [])
            return self.reply(200, {"id": "ytPlaylist1"})
        if rest == "/playlistItems":
            if method == "GET":
                with LOCK:
                    items = list(STATE["playlists"]["youtube"].get(q.get("playlistId", ""), []))
                return self.reply(200, {"items": [{"contentDetails": {"videoId": v}} for v in items]})
            f = self.fault("youtube_insert")
            if f == "429":
                return self.reply(429, {"error": {"code": 429, "errors": [{"reason": "rateLimitExceeded"}]}}, {"Retry-After": "120"})
            if f == "quota":
                return self.reply(403, {"error": {"code": 403, "errors": [{"reason": "quotaExceeded"}], "message": "quota"}})
            snip = json.loads(raw or "{}").get("snippet", {})
            pid = snip.get("playlistId", "")
            vid = snip.get("resourceId", {}).get("videoId", "")
            with LOCK:
                STATE["playlists"]["youtube"].setdefault(pid, []).append(vid)
                STATE["adds"]["youtube"][vid] = STATE["adds"]["youtube"].get(vid, 0) + 1
            return self.reply(200, {"id": "item-" + vid})
        return self.nope()

    # ── Apple ──────────────────────────────────────────────────────────────
    def svc_apple_api(self, method, rest, q, raw):
        if not self.headers.get("Authorization", "").startswith("Bearer "):
            return self.reply(401, {"errors": [{"status": "401"}]})
        m = re.match(r"^/catalog/([a-z]{2})/songs/(\d+)$", rest)
        if m:
            sid = m.group(2)
            if sid not in APPLE:
                return self.reply(404, {"errors": [{"status": "404", "title": "Resource Not Found"}]})
            return self.reply(200, {"data": [ap_song(sid)]})
        if re.match(r"^/catalog/[a-z]{2}/songs$", rest):
            isrc = q.get("filter[isrc]", "")
            return self.reply(200, {"data": [ap_song(s) for s, d in APPLE.items() if d["isrc"] == isrc]})
        if re.match(r"^/catalog/[a-z]{2}/search$", rest):
            if self.fault("apple_search") == "503":
                return self.reply(503, {"errors": [{"status": "503", "title": "Service Unavailable"}]})
            term = q.get("term", "").lower()
            songs = [ap_song(s) for s, d in APPLE.items() if d["name"].lower() in term]
            return self.reply(200, {"results": {"songs": {"data": songs}}} if songs else {"results": {}})
        return self.nope()

    def svc_itunes(self, method, rest, q, raw):
        sid = q.get("id", "")
        if rest != "/lookup" or sid not in APPLE:
            return self.reply(200, {"resultCount": 0, "results": []})
        s = APPLE[sid]
        return self.reply(200, {"resultCount": 1, "results": [{"wrapperType": "track", "trackId": int(sid),
                                                               "trackName": s["name"], "artistName": s["artistName"],
                                                               "trackTimeMillis": s["durationInMillis"]}]})

    # ── MusicBrainz ────────────────────────────────────────────────────────
    def svc_musicbrainz(self, method, rest, q, raw):
        if "CymbalOnWebsite/" not in self.headers.get("User-Agent", ""):
            return self.reply(403, {"error": "missing a contactable User-Agent"})
        if rest == "/url":
            res = q.get("resource", "")
            if res not in MB_URLS:
                return self.reply(404, {"error": "Not Found"})
            return self.reply(200, {"resource": res, "relations": [{"target-type": "recording", "recording": {"id": r}}
                                                                   for r in MB_URLS[res]]})
        m = re.match(r"^/recording/([a-z0-9-]+)$", rest)
        if m and m.group(1) in MB_RECORDINGS:
            return self.reply(200, MB_RECORDINGS[m.group(1)])
        return self.reply(404, {"error": "Not Found"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8098)
    args = ap.parse_args()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
