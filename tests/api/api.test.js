// tests/api/api.test.js — Cymbal end to end. Run through tests/api/run.sh, which starts
// a throwaway local PocketBase and tests/api/mock.py. Tests run in order and share
// state: people are made in setup, the stage is cleared before providers connect.
//
// Posting needs no account. A "person" here is a typed name, a browser key sent as
// X-Cymbal-Key, and a client address sent as CF-Connecting-IP. Only the owner (and
// one signed-in non-owner, to prove the role check) holds a PocketBase session.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const BASE = process.env.PB_URL;
const MOCK = process.env.MOCK_URL;
if (!BASE || !MOCK) throw new Error("run through tests/api/run.sh");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U = {};
let SU = "";
let seq = 0;
const rid = () => "req-" + Date.now().toString(36) + "-" + (++seq);
const newKey = () => crypto.randomBytes(24).toString("hex");
const SP = {
  bohemian: "4u7EnebtmKWzUH433cf5Qv",
  rick: "4uLU6hMCjMI75M1A2tKUQC",
  echo: "Ambiguous0000000000001",
  live: "LiveSong00000000000001",
  maybe: "Uncertain0000000000001",
  revoked: "Revoked000000000000001",
};
const spUrl = (id) => "https://open.spotify.com/track/" + id;
const randomSpotifyId = () => Array.from({ length: 22 }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 62)]).join("");
const P = {};

async function call(method, path, opts = {}) {
  const headers = {};
  if (opts.token) headers.Authorization = opts.token;
  if (opts.key) headers["X-Cymbal-Key"] = opts.key;
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method, headers, redirect: "manual",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* not json */ }
  return { status: res.status, json, text, location: res.headers.get("location") };
}
const as = (who) => {
  const p = U[who];
  const o = { token: p.token, key: p.key, ip: p.ip };
  return {
    get: (path) => call("GET", path, o),
    post: (path, b) => call("POST", path, Object.assign({ body: b || {} }, o)),
    del: (path) => call("DELETE", path, o),
  };
};
const su = (method, path, body) => call(method, path, { token: SU, body });
async function mock(path, body) {
  const res = await fetch(MOCK + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  return res.json();
}
async function share(who, url, caption, request) {
  const r = await as(who).post("/api/cymbal/posts", { url, name: U[who].name, caption: caption || "", request_id: request || rid() });
  assert.equal(r.status, 200, who + " posting " + url + ": " + r.text);
  return r.json.post;
}
async function rows(postId) {
  const r = await su("GET", "/api/collections/playlist_syncs/records?perPage=10&filter=" + encodeURIComponent('post="' + postId + '"'));
  const out = {};
  r.json.items.forEach((x) => { out[x.target] = x; });
  return out;
}
async function connection(provider) {
  const r = await su("GET", "/api/collections/provider_connections/records?filter=" + encodeURIComponent('provider="' + provider + '"'));
  return r.json.items[0];
}
async function runSync() {
  for (let i = 0; i < 30; i++) {
    const r = await as("owner").post("/api/cymbal/owner/sync/run");
    assert.equal(r.status, 200, r.text);
    if (!r.json.skipped) return r.json;
    await sleep(1000);
  }
  throw new Error("sync never got a turn");
}
async function makeDue(postId) {
  const all = await rows(postId);
  for (const t of Object.keys(all)) {
    if (all[t].status === "pending") await su("PATCH", "/api/collections/playlist_syncs/records/" + all[t].id, { next_at: "" });
  }
}
async function drain(postId) {
  for (let i = 0; i < 6; i++) {
    await runSync();
    const all = await rows(postId);
    if (!Object.values(all).some((r) => r.status === "pending")) return all;
    await makeDue(postId);
  }
  return rows(postId);
}
async function adds() {
  return (await mock("/__state")).adds;
}

// ── setup ───────────────────────────────────────────────────────────────────

async function account(name, role) {
  const email = name + "@cymbal.invalid";
  const pw = "pw-" + Math.random().toString(36).slice(2) + "-Xy9";
  const c = await su("POST", "/api/collections/users/records", { email, password: pw, passwordConfirm: pw, name, role });
  assert.equal(c.status, 200, c.text);
  const t = await su("POST", "/api/collections/users/impersonate/" + c.json.id, {});
  assert.equal(t.status, 200, t.text);
  return { id: c.json.id, token: t.json.token };
}

test("setup: a superuser, the owner's session, one non-owner session, and six people", async () => {
  const r = await call("POST", "/api/collections/_superusers/auth-with-password", {
    body: { identity: process.env.SU_EMAIL, password: process.env.SU_PASS },
  });
  assert.equal(r.status, 200, r.text);
  SU = r.json.token;
  const owner = await account("owner", "admin");
  const member = await account("member", "user");
  U.owner = { name: "Sol", key: newKey(), ip: "198.51.100.1", token: owner.token, id: owner.id };
  U.member = { name: "Mem", key: newKey(), ip: "198.51.100.9", token: member.token, id: member.id };
  ["ann", "ben", "cat", "dan", "eve"].forEach((n, i) => {
    U[n] = { name: n[0].toUpperCase() + n.slice(1), key: newKey(), ip: "198.51.100." + (2 + i) };
  });
  U.nokey = { ip: "198.51.100.99" };
  await mock("/__reset", {});
});

// ── access ──────────────────────────────────────────────────────────────────

test("anyone can read; nobody but the owner reaches the owner routes", async () => {
  assert.equal((await call("GET", "/api/cymbal/feed")).status, 200);
  assert.equal((await call("GET", "/api/cymbal/playlists")).status, 200);
  const home = await call("GET", "/");
  assert.equal(home.status, 200);
  assert.match(home.text, /CYMBAL/);
  assert.equal((await call("GET", "/api/health")).status, 200);
  const owner = [["GET", "/api/cymbal/owner/status"], ["POST", "/api/cymbal/owner/sync/run"], ["POST", "/api/cymbal/owner/apple/claim"],
    ["GET", "/api/cymbal/owner/apple/config"], ["POST", "/api/cymbal/owner/oauth/spotify/start"], ["GET", "/api/cymbal/owner/syncs"]];
  for (const [method, path] of owner) {
    const anon = await call(method, path, { key: U.ann.key, body: method === "POST" ? {} : undefined });
    assert.equal(anon.status, 401, "no session: " + path + " -> " + anon.status);
    const member = await call(method, path, { token: U.member.token, body: method === "POST" ? {} : undefined });
    assert.equal(member.status, 403, "non-owner session: " + path + " -> " + member.status);
  }
});

test("the collection API stays closed to everyone but the superuser", async () => {
  for (const c of ["posts", "comments", "playlist_syncs", "playlist_memberships", "provider_connections", "oauth_states"]) {
    for (const token of [U.member.token, U.owner.token, ""]) {
      const list = await call("GET", "/api/collections/" + c + "/records", { token });
      assert.equal(list.status, 403, c + " list -> " + list.status);
      const create = await call("POST", "/api/collections/" + c + "/records", { token, body: { caption: "x" } });
      assert.equal(create.status, 403, c + " create -> " + create.status);
    }
  }
});

test("identity: a signed-in person cannot make themselves owner, and sessions are not renewed locally", async () => {
  const r = await call("PATCH", "/api/collections/users/records/" + U.member.id, { token: U.member.token, body: { role: "admin" } });
  assert.notEqual(r.status, 200);
  const me = await su("GET", "/api/collections/users/records/" + U.member.id);
  assert.equal(me.json.role, "user");
  const refresh = await call("POST", "/api/collections/users/auth-refresh", { token: U.member.token, body: {} });
  assert.equal(refresh.status, 400);
  const signup = await call("POST", "/api/collections/users/records", { body: { email: "x@cymbal.invalid", password: "abcdefgh1", passwordConfirm: "abcdefgh1" } });
  assert.notEqual(signup.status, 200, "no self-service accounts");
});

// ── posting ─────────────────────────────────────────────────────────────────

test("unsupported and unsafe links are refused before any server fetch", async () => {
  const before = (await mock("/__log")).log.length;
  for (const bad of [
    "https://open.spotify.com/album/" + SP.bohemian,
    "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
    "https://music.apple.com/gb/album/a-night-at-the-opera/1440650428",
    "https://www.youtube.com/@queen",
    "https://www.youtube.com/playlist?list=PL0",
    "https://open.spotify.com.evil.example/track/" + SP.bohemian,
    "https://open.spotify.com@127.0.0.1/track/" + SP.bohemian,
    "https://127.0.0.1:8098/spotify_api/tracks/" + SP.bohemian,
    "http://open.spotify.com/track/" + SP.bohemian,
    "https://spotify.link/abc",
    "file:///etc/passwd",
  ]) {
    const r = await as("ann").post("/api/cymbal/posts", { url: bad, name: "Ann", request_id: rid() });
    assert.equal(r.status, 400, bad + " -> " + r.status);
    assert.ok(r.json.message && !/stack|goja|Error:/i.test(r.json.message), r.json.message);
  }
  const after = (await mock("/__log")).log.length;
  assert.equal(after, before, "a refused link must not cause any provider request");
});

test("posting needs a name and a browser key, and nothing else", async () => {
  const url = spUrl(randomSpotifyId());
  assert.equal((await call("POST", "/api/cymbal/posts", { ip: "198.51.100.50", body: { url, name: "Zed", request_id: rid() } })).status, 400, "no key");
  assert.equal((await call("POST", "/api/cymbal/posts", { key: "short", body: { url, name: "Zed", request_id: rid() } })).status, 400, "malformed key");
  assert.equal((await as("ann").post("/api/cymbal/posts", { url, request_id: rid() })).status, 400, "no name");
  assert.equal((await as("ann").post("/api/cymbal/posts", { url, name: "A", request_id: rid() })).status, 400, "one-letter name");
  assert.equal((await as("ann").post("/api/cymbal/posts", { url, name: "x".repeat(33), request_id: rid() })).status, 400, "long name");
});

test("a post is one post and three sync rows; replaying from the same browser returns it", async () => {
  const request = rid();
  const p = await share("ann", spUrl(SP.bohemian), "absolute tune", request);
  assert.equal(p.title, "Bohemian Rhapsody");
  assert.equal(p.artist, "Queen");
  assert.equal(p.poster, "Ann");
  assert.equal(p.mine, true);
  assert.equal(p.can_delete, true);
  const all = await rows(p.id);
  assert.equal(Object.keys(all).length, 3);
  assert.equal(all.spotify.target_id, SP.bohemian);
  assert.equal(all.spotify.match_basis, "source");

  const again = await as("ann").post("/api/cymbal/posts", { url: spUrl(SP.bohemian), name: "Ann", caption: "different", request_id: request });
  assert.equal(again.json.replayed, true);
  assert.equal(again.json.post.id, p.id);
  assert.equal(again.json.post.caption, "absolute tune");

  const other = await as("ben").post("/api/cymbal/posts", { url: spUrl(SP.bohemian), name: "Ben", request_id: request });
  assert.equal(other.status, 200);
  assert.equal(other.json.replayed, false, "a request id belongs to the browser that sent it");
  assert.notEqual(other.json.post.id, p.id);

  const dup = await share("ann", spUrl(SP.bohemian), "posting it twice on purpose");
  assert.notEqual(dup.id, p.id, "a second request is a second post");
  P.annFirst = p;
  P.benBohemian = other.json.post;
});

test("captions are stored and returned as text, never as markup", async () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script> & "quotes"';
  const p = await share("ann", spUrl(randomSpotifyId()), hostile + String.fromCharCode(7));
  assert.equal(p.caption, hostile, "only control characters are removed");
  const long = await as("ann").post("/api/cymbal/posts", { url: spUrl(randomSpotifyId()), name: "Ann", caption: "x".repeat(501), request_id: rid() });
  assert.equal(long.status, 400);
  const noId = await as("ann").post("/api/cymbal/posts", { url: spUrl(randomSpotifyId()), name: "Ann" });
  assert.equal(noId.status, 400);
});

test("responses carry no keys, key hashes, addresses or tokens", async () => {
  const r = await as("ben").get("/api/cymbal/feed");
  assert.equal(r.status, 200);
  const annHash = crypto.createHash("sha256").update(U.ann.key).digest("hex");
  for (const secret of [U.ann.key, U.ben.key, annHash, U.ann.ip, "author_key", "ip_hash", "author", "request_id", "@cymbal.invalid", "sp-user", "evidence", "lease"]) {
    assert.ok(!r.text.includes(secret), "feed leaked " + secret);
  }
  const annPost = r.json.posts.find((p) => p.id === P.annFirst.id);
  assert.equal(annPost.mine, false, "Ben is not Ann");
  assert.equal(annPost.can_delete, false);
  const anon = await call("GET", "/api/cymbal/feed");
  assert.ok(anon.json.posts.every((p) => p.mine === false && p.can_delete === false));
});

test("pagination walks the feed once, newest first", async () => {
  // ann has 3 posts and ben 1; add 16 more across three people to reach 20.
  for (let i = 0; i < 5; i++) await share("ben", spUrl(randomSpotifyId()), "ben " + i);
  for (let i = 0; i < 6; i++) await share("cat", spUrl(randomSpotifyId()), "cat " + i);
  for (let i = 0; i < 5; i++) await share("owner", spUrl(randomSpotifyId()), "owner " + i);
  const one = await call("GET", "/api/cymbal/feed");
  assert.equal(one.json.posts.length, 15);
  assert.ok(one.json.next_cursor);
  const two = await call("GET", "/api/cymbal/feed?cursor=" + one.json.next_cursor);
  assert.equal(two.json.posts.length, 5);
  assert.equal(two.json.next_cursor, "");
  const all = one.json.posts.concat(two.json.posts);
  assert.equal(new Set(all.map((p) => p.id)).size, 20);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].created >= all[i].created, "newest first");
  assert.equal((await call("GET", "/api/cymbal/feed?cursor=nope")).status, 400);
});

test("rate limits per browser: ten posts an hour, and deleting one does not buy another", async () => {
  const mine = [];
  for (let i = 0; i < 10; i++) mine.push(await share("dan", spUrl(randomSpotifyId())));
  const eleventh = await as("dan").post("/api/cymbal/posts", { url: spUrl(randomSpotifyId()), name: "Dan", request_id: rid() });
  assert.equal(eleventh.status, 429);
  assert.equal((await as("dan").del("/api/cymbal/posts/" + mine[0].id)).status, 200);
  const twelfth = await as("dan").post("/api/cymbal/posts", { url: spUrl(randomSpotifyId()), name: "Dan", request_id: rid() });
  assert.equal(twelfth.status, 429);
});

test("rate limits per network: a fresh browser key does not escape the address limit", async () => {
  const ip = "203.0.113.9";
  for (let k = 0; k < 3; k++) {
    const key = newKey();
    for (let i = 0; i < 10; i++) {
      const r = await call("POST", "/api/cymbal/posts", { key, ip, body: { url: spUrl(randomSpotifyId()), name: "Spam" + k, request_id: rid() } });
      assert.equal(r.status, 200, "key " + k + " post " + i + ": " + r.text);
    }
  }
  const blocked = await call("POST", "/api/cymbal/posts", { key: newKey(), ip, body: { url: spUrl(randomSpotifyId()), name: "Spam4", request_id: rid() } });
  assert.equal(blocked.status, 429);
  const elsewhere = await call("POST", "/api/cymbal/posts", { key: newKey(), ip: "203.0.113.10", body: { url: spUrl(randomSpotifyId()), name: "Fine", request_id: rid() } });
  assert.equal(elsewhere.status, 200, "another network is unaffected");
});

test("comments: named, replay-safe, counted and rate limited per browser", async () => {
  const postId = P.annFirst.id;
  const request = rid();
  const c = await as("ben").post("/api/cymbal/posts/" + postId + "/comments", { body: "tune", name: "Ben", request_id: request });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.comment.poster, "Ben");
  assert.equal(c.json.comment.mine, true);
  P.benComment = c.json.comment.id;
  const again = await as("ben").post("/api/cymbal/posts/" + postId + "/comments", { body: "tune", name: "Ben", request_id: request });
  assert.equal(again.json.replayed, true);
  assert.equal(again.json.comment.id, c.json.comment.id);
  const list = await as("ann").get("/api/cymbal/posts/" + postId + "/comments");
  assert.equal(list.json.comments.length, 1);
  assert.equal(list.json.comments[0].mine, false);
  assert.ok(!list.text.includes(U.ben.key));
  assert.equal((await as("ann").post("/api/cymbal/posts/" + postId + "/comments", { body: "", name: "Ann", request_id: rid() })).status, 400);
  assert.equal((await as("ann").post("/api/cymbal/posts/" + postId + "/comments", { body: "hi", request_id: rid() })).status, 400, "a name is required");
  assert.equal((await as("ann").post("/api/cymbal/posts/" + postId + "/comments", { body: "y".repeat(1001), name: "Ann", request_id: rid() })).status, 400);
  for (let i = 0; i < 60; i++) {
    const r = await as("cat").post("/api/cymbal/posts/" + postId + "/comments", { body: "c" + i, name: "Cat", request_id: rid() });
    assert.equal(r.status, 200, "comment " + i + ": " + r.text);
  }
  const over = await as("cat").post("/api/cymbal/posts/" + postId + "/comments", { body: "one too many", name: "Cat", request_id: rid() });
  assert.equal(over.status, 429);
  const rec = await su("GET", "/api/collections/posts/records/" + postId);
  assert.equal(rec.json.comment_count, 61, "ben's one and cat's sixty");
});

test("only the writing browser or the owner removes a post or comment", async () => {
  const postId = P.annFirst.id;
  assert.equal((await as("ben").del("/api/cymbal/posts/" + postId)).status, 403);
  assert.equal((await call("DELETE", "/api/cymbal/posts/" + postId)).status, 403, "no key, no session");
  assert.equal((await call("DELETE", "/api/cymbal/posts/" + postId, { token: U.member.token })).status, 403, "a non-owner session");
  assert.equal((await as("ann").del("/api/cymbal/comments/" + P.benComment)).status, 403);
  assert.equal((await as("owner").del("/api/cymbal/comments/" + P.benComment)).status, 200, "the owner moderates comments");
  assert.equal((await as("owner").del("/api/cymbal/posts/" + P.benBohemian.id)).status, 200, "the owner moderates posts");
  const ownerView = (await as("owner").get("/api/cymbal/feed")).json.posts;
  assert.ok(ownerView.every((p) => p.can_delete === true), "the owner can remove anything");
  assert.equal((await as("ann").del("/api/cymbal/posts/" + postId)).status, 200);
  const feed = await as("ben").get("/api/cymbal/feed");
  assert.ok(!feed.json.posts.some((p) => p.id === postId));
  assert.equal((await as("ben").get("/api/cymbal/posts/" + postId + "/comments")).status, 404);
  const rec = await su("GET", "/api/collections/posts/records/" + postId);
  assert.equal(rec.json.caption, "");
  assert.equal(rec.json.deleted, true);
  assert.equal(rec.json.deleted_by, "author");
  const all = await rows(postId);
  assert.ok(Object.values(all).every((r) => r.status === "cancelled" || r.status === "synced"));
});

test("clear the stage before providers connect", async () => {
  for (;;) {
    const r = await as("owner").get("/api/cymbal/feed");
    if (!r.json.posts.length) break;
    for (const p of r.json.posts) assert.equal((await as("owner").del("/api/cymbal/posts/" + p.id)).status, 200);
  }
});

// ── providers ───────────────────────────────────────────────────────────────

async function oauth(provider) {
  const start = await as("owner").post("/api/cymbal/owner/oauth/" + provider + "/start");
  assert.equal(start.status, 200, start.text);
  const url = new URL(start.json.url);
  assert.ok(url.href.startsWith(MOCK), url.href);
  assert.equal(url.searchParams.get("redirect_uri"), BASE + "/api/cymbal/oauth/" + provider + "/callback");
  return url.searchParams.get("state");
}

test("the owner connects Spotify and YouTube; OAuth state is single-use", async () => {
  const state = await oauth("spotify");
  const ok = await call("GET", "/api/cymbal/oauth/spotify/callback?code=good-code&state=" + state);
  assert.equal(ok.status, 302);
  assert.equal(ok.location, BASE + "/?connected=spotify");
  const replay = await call("GET", "/api/cymbal/oauth/spotify/callback?code=good-code&state=" + state);
  assert.equal(replay.location, BASE + "/?connect=expired");
  const forged = await call("GET", "/api/cymbal/oauth/spotify/callback?code=good-code&state=" + "A".repeat(40));
  assert.equal(forged.location, BASE + "/?connect=expired");
  const crossed = await oauth("youtube");
  const wrong = await call("GET", "/api/cymbal/oauth/spotify/callback?code=good-code&state=" + crossed);
  assert.equal(wrong.location, BASE + "/?connect=expired", "a YouTube state cannot complete a Spotify connection");
  const deniedState = await oauth("youtube");
  const denied = await call("GET", "/api/cymbal/oauth/youtube/callback?error=access_denied&state=" + deniedState);
  assert.equal(denied.location, BASE + "/?connect=denied");
  const yt = await oauth("youtube");
  const ytOk = await call("GET", "/api/cymbal/oauth/youtube/callback?code=good-code&state=" + yt);
  assert.equal(ytOk.location, BASE + "/?connected=youtube");

  const s = await as("owner").get("/api/cymbal/owner/status");
  const by = Object.fromEntries(s.json.providers.map((p) => [p.provider, p]));
  assert.equal(by.spotify.status, "connected");
  assert.equal(by.spotify.account, "Owner Test");
  assert.equal(by.youtube.account, "Owner Channel");
  const row = await connection("spotify");
  assert.ok(row.access_token_enc && !row.access_token_enc.includes("sp-user-1"), "tokens are encrypted at rest");
  assert.ok(!row.refresh_token_enc.includes("sp-refresh"));
  assert.ok(!s.text.includes("sp-user") && !s.text.includes("_enc"), "the owner panel never returns tokens");
});

test("each playlist is created once, and everyone gets the three links", async () => {
  for (const p of ["spotify", "youtube"]) {
    const a = await as("owner").post("/api/cymbal/owner/providers/" + p + "/playlist");
    assert.equal(a.status, 200, a.text);
    assert.equal(a.json.created, true);
    const b = await as("owner").post("/api/cymbal/owner/providers/" + p + "/playlist");
    assert.equal(b.json.created, false);
  }
  assert.equal((await as("owner").post("/api/cymbal/owner/apple/playlist", { library_id: "p.TestLibrary1" })).status, 200);
  assert.equal((await as("owner").post("/api/cymbal/owner/apple/share-url", { url: "https://evil.example/playlist/pl.u-x" })).status, 400);
  assert.equal((await as("owner").post("/api/cymbal/owner/apple/share-url",
    { url: "https://music.apple.com/gb/playlist/cymbal-on-website/pl.u-TestShare01" })).status, 200);
  const links = await call("GET", "/api/cymbal/playlists");
  assert.ok(links.json.playlists.every((p) => p.ready && p.url.startsWith("https://")), links.text);
});

// ── sync ────────────────────────────────────────────────────────────────────

test("a Spotify post reaches all three: exact, ISRC, and a Topic upload", async () => {
  const p = await share("ann", spUrl(SP.bohemian), "again, for the playlists");
  P.one = p.id;
  const all = await drain(p.id);
  assert.equal(all.spotify.status, "synced");
  assert.equal(all.youtube.status, "synced");
  assert.equal(all.youtube.target_id, "fJ9rUzIMcZQ", "the Topic upload beats the VEVO video");
  assert.equal(all.youtube.match_basis, "metadata");
  assert.equal(all.apple_music.status, "pending_device");
  assert.equal(all.apple_music.target_id, "1440650711");
  assert.equal(all.apple_music.match_basis, "isrc");
  const a = await adds();
  assert.equal(a.spotify[SP.bohemian], 1);
  assert.equal(a.youtube.fJ9rUzIMcZQ, 1);
  const card = (await call("GET", "/api/cymbal/feed")).json.posts.find((x) => x.id === p.id);
  assert.equal(card.sync.spotify.state, "synced");
  assert.equal(card.sync.apple_music.state, "pending");
});

test("posting the same song again adds nothing to any playlist", async () => {
  const p = await share("ben", spUrl(SP.bohemian));
  P.two = p.id;
  const all = await drain(p.id);
  assert.equal(all.spotify.status, "synced");
  assert.equal(all.youtube.status, "synced");
  const a = await adds();
  assert.equal(a.spotify[SP.bohemian], 1);
  assert.equal(a.youtube.fJ9rUzIMcZQ, 1);
});

test("an Apple Music post of the same song is queued for the device and deduplicated elsewhere", async () => {
  const p = await share("cat", "https://music.apple.com/gb/album/a-night-at-the-opera/1440650428?i=1440650711");
  P.three = p.id;
  assert.equal((await rows(p.id)).apple_music.status, "pending_device");
  const all = await drain(p.id);
  assert.equal(all.spotify.status, "synced");
  assert.equal(all.spotify.match_basis, "isrc");
  assert.equal(all.youtube.status, "synced");
  const a = await adds();
  assert.equal(a.spotify[SP.bohemian], 1);
  assert.equal(a.youtube.fJ9rUzIMcZQ, 1);
});

test("ambiguous matches are never guessed, and the owner repairs them with an exact link", async () => {
  const p = await share("ann", spUrl(SP.echo));
  P.four = p.id;
  const all = await drain(p.id);
  assert.equal(all.spotify.status, "synced");
  assert.equal(all.apple_music.status, "attention");
  assert.equal(all.apple_music.reason, "ambiguous");
  assert.equal(all.youtube.status, "attention");
  assert.equal(all.youtube.reason, "no_match");
  const attn = await as("owner").get("/api/cymbal/owner/syncs?status=attention");
  assert.ok(attn.json.syncs.some((s) => s.id === all.apple_music.id && s.post && s.post.title === "Echo Chamber"));
  const friend = (await call("GET", "/api/cymbal/feed")).json.posts.find((x) => x.id === p.id);
  assert.equal(friend.sync.apple_music.state, "attention");
  const wrong = await as("owner").post("/api/cymbal/owner/syncs/" + all.apple_music.id + "/override", { url: "https://youtu.be/dQw4w9WgXcQ" });
  assert.equal(wrong.status, 400);
  assert.equal((await call("POST", "/api/cymbal/owner/syncs/" + all.apple_music.id + "/override", { token: U.member.token, body: { url: "https://music.apple.com/gb/song/x/1000000001" } })).status, 403);
  const fix = await as("owner").post("/api/cymbal/owner/syncs/" + all.apple_music.id + "/override", { url: "https://music.apple.com/gb/song/echo-chamber/1000000001" });
  assert.equal(fix.status, 200, fix.text);
  const after = await rows(p.id);
  assert.equal(after.apple_music.status, "pending_device");
  assert.equal(after.apple_music.target_id, "1000000001");
  assert.equal(after.apple_music.match_basis, "manual");
});

test("a live recording never matches the studio one", async () => {
  const p = await share("ann", spUrl(SP.live));
  P.five = p.id;
  const all = await drain(p.id);
  assert.equal(all.apple_music.status, "attention");
  assert.equal(all.apple_music.reason, "no_match");
  assert.ok(all.apple_music.evidence.rejected.some((r) => r.reasons.includes("version")), JSON.stringify(all.apple_music.evidence));
  assert.equal(all.youtube.status, "attention");
});

test("a YouTube post reaches Spotify and Apple through MusicBrainz, politely", async () => {
  const p = await share("ben", "https://youtu.be/dQw4w9WgXcQ");
  P.six = p.id;
  assert.equal(p.artist, "Rick Astley");
  const all = await drain(p.id);
  assert.equal(all.youtube.status, "synced");
  assert.equal(all.youtube.match_basis, "source");
  assert.equal(all.spotify.status, "synced");
  assert.equal(all.spotify.match_basis, "musicbrainz");
  assert.equal(all.spotify.target_id, SP.rick);
  assert.equal(all.apple_music.status, "pending_device");
  assert.equal(all.apple_music.target_id, "1558533900");
  const mb = (await mock("/__log")).log.filter((l) => l.path.startsWith("/musicbrainz"));
  assert.ok(mb.length >= 2);
  assert.ok(mb.every((l) => l.ua.startsWith("CymbalOnWebsite/")));
  for (let i = 1; i < mb.length; i++) assert.ok(mb[i].t - mb[i - 1].t >= 1.0, "MusicBrainz calls are at least a second apart");
});

test("a write that may have failed is verified before it is retried, never repeated", async () => {
  await mock("/__control", { once: { spotify_add: "500_after_apply" } });
  const p = await share("cat", spUrl(SP.maybe));
  P.seven = p.id;
  await runSync();
  let all = await rows(p.id);
  assert.equal(all.spotify.status, "pending");
  assert.equal(all.spotify.needs_verify, true);
  assert.equal(all.spotify.reason, "verifying");
  assert.equal((await adds()).spotify[SP.maybe], 1);
  all = await drain(p.id);
  assert.equal(all.spotify.status, "synced");
  assert.equal(all.spotify.needs_verify, false);
  assert.equal((await adds()).spotify[SP.maybe], 1, "confirmed from the playlist, not added again");
});

test("a 429 pauses the whole provider for Retry-After and keeps the job queued", async () => {
  await mock("/__control", { once: { youtube_insert: "429" } });
  const p = await share("owner", "https://www.youtube.com/watch?v=rateLimited");
  P.eight = p.id;
  await runSync();
  const r = (await rows(p.id)).youtube;
  assert.equal(r.status, "pending");
  assert.equal(r.reason, "rate_limited");
  assert.equal(r.attempts, 0, "a provider-wide pause is not this job's failure");
  const s = (await as("owner").get("/api/cymbal/owner/status")).json.providers.find((x) => x.provider === "youtube");
  assert.ok(s.cooldown_until, "cooldown is visible to the owner");
  assert.equal(s.ready, false);
  const conn = await connection("youtube");
  const until = Date.parse(conn.cooldown_until.replace(" ", "T"));
  assert.ok(until - Date.now() > 100 * 1000, "Retry-After: 120 is respected");
  await su("PATCH", "/api/collections/provider_connections/records/" + conn.id, { cooldown_until: "" });
  const all = await drain(p.id);
  assert.equal(all.youtube.status, "synced");
});

test("running out of YouTube quota leaves the job queued until the reset", async () => {
  await mock("/__control", { once: { youtube_insert: "quota" } });
  const p = await share("owner", "https://www.youtube.com/watch?v=quotaVideo1");
  await runSync();
  const r = (await rows(p.id)).youtube;
  assert.equal(r.status, "pending");
  assert.equal(r.reason, "quota");
  const conn = await connection("youtube");
  assert.ok(Date.parse(conn.cooldown_until.replace(" ", "T")) > Date.now());
  await su("PATCH", "/api/collections/provider_connections/records/" + conn.id, { cooldown_until: "" });
});

test("a transient provider failure backs off and says so", async () => {
  const row = (await rows(P.five)).apple_music;
  assert.equal((await as("owner").post("/api/cymbal/owner/syncs/" + row.id + "/retry")).status, 200);
  await mock("/__control", { once: { apple_search: "503" } });
  await runSync();
  const r = (await rows(P.five)).apple_music;
  assert.equal(r.status, "pending");
  assert.equal(r.reason, "retrying");
  assert.equal(r.attempts, 1);
  assert.ok(Date.parse(r.next_at.replace(" ", "T")) > Date.now(), "backed off");
});

test("Apple: claims are leased, stale leases are ignored, completion records membership", async () => {
  const claim = await as("owner").post("/api/cymbal/owner/apple/claim", { max: 25 });
  assert.equal(claim.status, 200, claim.text);
  assert.equal(claim.json.playlist_id, "p.TestLibrary1");
  const items = claim.json.items;
  const ids = items.map((i) => i.sync_id);
  for (const pid of [P.one, P.two, P.three, P.four, P.six]) {
    assert.ok(ids.includes((await rows(pid)).apple_music.id), "claimed " + pid);
  }
  assert.equal((await as("owner").post("/api/cymbal/owner/apple/claim", { max: 25 })).json.items.length, 0, "leased rows are not handed out twice");
  const first = items[0];
  const stale = await as("owner").post("/api/cymbal/owner/apple/complete", { results: [{ sync_id: first.sync_id, lease: "wrong", outcome: "added" }] });
  assert.equal(stale.json.completed, 0);
  const seen = new Set();
  const results = items.map((i) => {
    const outcome = seen.has(i.catalog_id) ? "present" : "added";
    seen.add(i.catalog_id);
    return { sync_id: i.sync_id, lease: i.lease, outcome };
  });
  const done = await as("owner").post("/api/cymbal/owner/apple/complete", { results });
  assert.equal(done.json.completed, items.length);
  for (const pid of [P.one, P.two, P.three, P.four, P.six]) assert.equal((await rows(pid)).apple_music.status, "synced");
  const m = await su("GET", "/api/collections/playlist_memberships/records?perPage=50&filter=" + encodeURIComponent('provider="apple_music"'));
  assert.equal(new Set(m.json.items.map((x) => x.item_id)).size, m.json.items.length, "one membership per item");
});

test("deleting a post mid-flight: cancelled if not added, synced if it really was", async () => {
  const a = await share("eve", "https://music.apple.com/gb/song/echo-chamber/1000000002");
  const claim = await as("owner").post("/api/cymbal/owner/apple/claim", { max: 25 });
  const item = claim.json.items.find((i) => i.catalog_id === "1000000002");
  assert.ok(item);
  assert.equal((await as("eve").del("/api/cymbal/posts/" + a.id)).status, 200);
  assert.equal((await rows(a.id)).apple_music.status, "cancelled");
  await as("owner").post("/api/cymbal/owner/apple/complete", { results: [{ sync_id: item.sync_id, lease: item.lease, outcome: "added" }] });
  assert.equal((await rows(a.id)).apple_music.status, "synced", "it is on the playlist, so the record says so");

  const b = await share("eve", "https://music.apple.com/gb/song/song-c/1000000003");
  assert.equal((await as("eve").del("/api/cymbal/posts/" + b.id)).status, 200);
  const later = await as("owner").post("/api/cymbal/owner/apple/claim", { max: 25 });
  assert.ok(!later.json.items.some((i) => i.catalog_id === "1000000003"));
  assert.equal((await rows(b.id)).apple_music.status, "cancelled");
});

test("readers see states, never match evidence or provider detail", async () => {
  const r = await call("GET", "/api/cymbal/feed");
  for (const k of ["evidence", "detail", "lease", "reason", "target_id", "attempts", "steps"]) assert.ok(!r.text.includes('"' + k + '"'), "leaked " + k);
});

test("a revoked Spotify authorisation parks Spotify work and asks for reconnecting", async () => {
  await mock("/__control", { set: { spotify_refresh: "invalid_grant" } });
  const conn = await connection("spotify");
  await su("PATCH", "/api/collections/provider_connections/records/" + conn.id, { token_expires_at: "2000-01-01 00:00:00.000Z" });
  const p = await share("eve", spUrl(SP.revoked));
  await runSync();
  const r = (await rows(p.id)).spotify;
  assert.equal(r.status, "pending");
  assert.equal(r.reason, "reconnect");
  const s = (await as("owner").get("/api/cymbal/owner/status")).json.providers.find((x) => x.provider === "spotify");
  assert.equal(s.status, "needs_reauth");
  assert.equal(s.ready, false);
  await runSync();
  assert.equal((await rows(p.id)).spotify.updated, r.updated, "no attempts while the provider waits for the owner");
  await mock("/__control", { clear: ["spotify_refresh"] });
});
