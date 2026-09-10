// tests/api/api.test.js — Cymbal end to end. Run through tests/api/run.sh, which starts
// a throwaway local PocketBase and tests/api/mock.py. Tests run in order and share
// state: friends are made in setup, the stage is cleared before providers connect.
const test = require("node:test");
const assert = require("node:assert/strict");

const BASE = process.env.PB_URL;
const MOCK = process.env.MOCK_URL;
if (!BASE || !MOCK) throw new Error("run through tests/api/run.sh");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const U = {};
let SU = "";
let seq = 0;
const rid = () => "req-" + Date.now().toString(36) + "-" + (++seq);
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
const as = (who) => ({ get: (p) => call("GET", p, { token: U[who].token }), post: (p, b) => call("POST", p, { token: U[who].token, body: b || {} }), del: (p) => call("DELETE", p, { token: U[who].token }) });
const su = (method, path, body) => call(method, path, { token: SU, body });
async function mock(path, body) {
  const res = await fetch(MOCK + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
  return res.json();
}
async function share(who, url, caption, request) {
  const r = await as(who).post("/api/cymbal/posts", { url, caption: caption || "", request_id: request || rid() });
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

test("setup: a superuser, an owner and five friends", async () => {
  const r = await call("POST", "/api/collections/_superusers/auth-with-password", {
    body: { identity: process.env.SU_EMAIL, password: process.env.SU_PASS },
  });
  assert.equal(r.status, 200, r.text);
  SU = r.json.token;
  for (const [name, role] of [["owner", "admin"], ["ann", "user"], ["ben", "user"], ["cat", "user"], ["dan", "user"], ["eve", "user"]]) {
    const email = name + "@cymbal.invalid";
    const pw = "pw-" + Math.random().toString(36).slice(2) + "-Xy9";
    const c = await su("POST", "/api/collections/users/records", {
      email, password: pw, passwordConfirm: pw, name: name[0].toUpperCase() + name.slice(1), role,
    });
    assert.equal(c.status, 200, c.text);
    const t = await su("POST", "/api/collections/users/impersonate/" + c.json.id, {});
    assert.equal(t.status, 200, t.text);
    U[name] = { id: c.json.id, token: t.json.token, email };
  }
  await mock("/__reset", {});
});

// ── access ──────────────────────────────────────────────────────────────────

test("signed-out callers reach nothing", async () => {
  for (const [method, path] of [["GET", "/api/cymbal/feed"], ["POST", "/api/cymbal/posts"], ["GET", "/api/cymbal/playlists"],
    ["GET", "/api/cymbal/posts/abcdefghijklmno/comments"], ["GET", "/api/cymbal/owner/status"],
    ["POST", "/api/cymbal/owner/sync/run"], ["POST", "/api/cymbal/owner/apple/claim"]]) {
    const r = await call(method, path, { body: method === "POST" ? {} : undefined });
    assert.equal(r.status, 401, method + " " + path + " -> " + r.status);
  }
  const home = await call("GET", "/");
  assert.equal(home.status, 200);
  assert.match(home.text, /CYMBAL/);
  assert.equal((await call("GET", "/api/health")).status, 200);
});

test("the collection API is closed to friends and to anonymous callers", async () => {
  for (const c of ["posts", "comments", "playlist_syncs", "playlist_memberships", "provider_connections", "oauth_states"]) {
    for (const token of [U.ann.token, U.owner.token, ""]) {
      const list = await call("GET", "/api/collections/" + c + "/records", { token });
      assert.equal(list.status, 403, c + " list -> " + list.status);
      const create = await call("POST", "/api/collections/" + c + "/records", { token, body: { caption: "x" } });
      assert.equal(create.status, 403, c + " create -> " + create.status);
    }
  }
  const users = await as("ann").get("/api/collections/users/records");
  assert.equal(users.status, 200);
  assert.deepEqual(users.json.items.map((u) => u.id), [U.ann.id], "a friend sees only their own user record");
});

test("friends cannot reach the owner's routes", async () => {
  for (const [m, p] of [["get", "/api/cymbal/owner/status"], ["post", "/api/cymbal/owner/sync/run"], ["post", "/api/cymbal/owner/apple/claim"],
    ["get", "/api/cymbal/owner/apple/config"], ["post", "/api/cymbal/owner/oauth/spotify/start"], ["get", "/api/cymbal/owner/syncs"]]) {
    const r = await as("ann")[m](p);
    assert.equal(r.status, 403, p + " -> " + r.status);
  }
});

test("identity: nobody sets their own role, and sessions are not renewed locally", async () => {
  const r = await call("PATCH", "/api/collections/users/records/" + U.ann.id, { token: U.ann.token, body: { role: "admin" } });
  assert.notEqual(r.status, 200);
  const me = await su("GET", "/api/collections/users/records/" + U.ann.id);
  assert.equal(me.json.role, "user");
  const refresh = await call("POST", "/api/collections/users/auth-refresh", { token: U.ann.token, body: {} });
  assert.equal(refresh.status, 400);
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
    const r = await as("ann").post("/api/cymbal/posts", { url: bad, request_id: rid() });
    assert.equal(r.status, 400, bad + " -> " + r.status);
    assert.ok(r.json.message && !/stack|goja|Error:/i.test(r.json.message), r.json.message);
  }
  const after = (await mock("/__log")).log.length;
  assert.equal(after, before, "a refused link must not cause any provider request");
});

test("a post is one post and three sync rows; replaying its request id returns it", async () => {
  const request = rid();
  const p = await share("ann", spUrl(SP.bohemian), "absolute tune", request);
  assert.equal(p.title, "Bohemian Rhapsody");
  assert.equal(p.artist, "Queen");
  assert.equal(p.source, "spotify");
  assert.equal(p.poster, "Ann");
  assert.deepEqual(Object.keys(p.sync).sort(), ["apple_music", "spotify", "youtube"]);
  const all = await rows(p.id);
  assert.equal(Object.keys(all).length, 3);
  assert.equal(all.spotify.target_id, SP.bohemian);
  assert.equal(all.spotify.match_basis, "source");

  const again = await as("ann").post("/api/cymbal/posts", { url: spUrl(SP.bohemian), caption: "different", request_id: request });
  assert.equal(again.status, 200);
  assert.equal(again.json.replayed, true);
  assert.equal(again.json.post.id, p.id);
  assert.equal(again.json.post.caption, "absolute tune");

  const dup = await share("ann", spUrl(SP.bohemian), "posting it twice on purpose");
  assert.notEqual(dup.id, p.id, "a second request is a second post");
  P.annFirst = p;
});

test("captions are stored and returned as text, never as markup", async () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script> & "quotes"';
  const p = await share("ann", spUrl(randomSpotifyId()), hostile + String.fromCharCode(7));
  assert.equal(p.caption, hostile, "only control characters are removed");
  const long = await as("ann").post("/api/cymbal/posts", { url: spUrl(randomSpotifyId()), caption: "x".repeat(501), request_id: rid() });
  assert.equal(long.status, 400);
  const noId = await as("ann").post("/api/cymbal/posts", { url: spUrl(randomSpotifyId()) });
  assert.equal(noId.status, 400);
});

test("responses carry no author ids, emails or tokens", async () => {
  const r = await as("ben").get("/api/cymbal/feed");
  assert.equal(r.status, 200);
  for (const secret of [U.ann.id, U.owner.id, U.ben.id, "@cymbal.invalid", "author", "request_id", "sp-user", "evidence", "lease"]) {
    assert.ok(!r.text.includes(secret), "feed leaked " + secret);
  }
  assert.ok(r.json.posts.every((p) => p.mine === false && p.can_delete === false));
});

test("pagination walks the feed once, newest first", async () => {
  // ann has 3 posts; add 17 more across three people to reach 20.
  for (let i = 0; i < 6; i++) await share("ben", spUrl(randomSpotifyId()), "ben " + i);
  for (let i = 0; i < 6; i++) await share("cat", spUrl(randomSpotifyId()), "cat " + i);
  for (let i = 0; i < 5; i++) await share("owner", spUrl(randomSpotifyId()), "owner " + i);
  const one = await as("ann").get("/api/cymbal/feed");
  assert.equal(one.json.posts.length, 15);
  assert.ok(one.json.next_cursor);
  const two = await as("ann").get("/api/cymbal/feed?cursor=" + one.json.next_cursor);
  assert.equal(two.json.posts.length, 5);
  assert.equal(two.json.next_cursor, "");
  const all = one.json.posts.concat(two.json.posts);
  assert.equal(new Set(all.map((p) => p.id)).size, 20);
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].created >= all[i].created, "newest first");
  assert.equal((await as("ann").get("/api/cymbal/feed?cursor=nope")).status, 400);
});

test("rate limits: ten posts an hour, and deleting one does not buy another", async () => {
  const mine = [];
  for (let i = 0; i < 10; i++) mine.push(await share("dan", spUrl(randomSpotifyId())));
  const eleventh = await as("dan").post("/api/cymbal/posts", { url: spUrl(randomSpotifyId()), request_id: rid() });
  assert.equal(eleventh.status, 429);
  assert.equal((await as("dan").del("/api/cymbal/posts/" + mine[0].id)).status, 200);
  const twelfth = await as("dan").post("/api/cymbal/posts", { url: spUrl(randomSpotifyId()), request_id: rid() });
  assert.equal(twelfth.status, 429);
});

test("comments: attributed, replay-safe, counted and rate limited", async () => {
  const postId = P.annFirst.id;
  const request = rid();
  const c = await as("ben").post("/api/cymbal/posts/" + postId + "/comments", { body: "tune", request_id: request });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.comment.poster, "Ben");
  P.benComment = c.json.comment.id;
  const again = await as("ben").post("/api/cymbal/posts/" + postId + "/comments", { body: "tune", request_id: request });
  assert.equal(again.json.replayed, true);
  assert.equal(again.json.comment.id, c.json.comment.id);
  const list = await as("ann").get("/api/cymbal/posts/" + postId + "/comments");
  assert.equal(list.json.comments.length, 1);
  assert.equal(list.json.comments[0].mine, false);
  assert.ok(!list.text.includes(U.ben.id));
  assert.equal((await as("ann").post("/api/cymbal/posts/" + postId + "/comments", { body: "", request_id: rid() })).status, 400);
  assert.equal((await as("ann").post("/api/cymbal/posts/" + postId + "/comments", { body: "y".repeat(1001), request_id: rid() })).status, 400);
  for (let i = 0; i < 60; i++) {
    const r = await as("cat").post("/api/cymbal/posts/" + postId + "/comments", { body: "c" + i, request_id: rid() });
    assert.equal(r.status, 200, "comment " + i + ": " + r.text);
  }
  const over = await as("cat").post("/api/cymbal/posts/" + postId + "/comments", { body: "one too many", request_id: rid() });
  assert.equal(over.status, 429);
  const rec = await su("GET", "/api/collections/posts/records/" + postId);
  assert.equal(rec.json.comment_count, 61, "ben's one and cat's sixty");
});

test("only the author or the owner removes a post or comment", async () => {
  const postId = P.annFirst.id;
  assert.equal((await as("ben").del("/api/cymbal/posts/" + postId)).status, 403);
  assert.equal((await as("ann").del("/api/cymbal/comments/" + P.benComment)).status, 403);
  assert.equal((await as("owner").del("/api/cymbal/comments/" + P.benComment)).status, 200);
  const benPosts = await su("GET", "/api/collections/posts/records?perPage=1&filter=" +
    encodeURIComponent('author="' + U.ben.id + '" && deleted=false'));
  const benPost = benPosts.json.items[0];
  assert.ok(benPost, "ben has a live post to moderate");
  assert.equal((await as("owner").del("/api/cymbal/posts/" + benPost.id)).status, 200, "the owner moderates");
  assert.equal((await as("ann").del("/api/cymbal/posts/" + postId)).status, 200);
  const feed = await as("ben").get("/api/cymbal/feed");
  assert.ok(!feed.json.posts.some((p) => p.id === postId));
  assert.equal((await as("ben").get("/api/cymbal/posts/" + postId + "/comments")).status, 404);
  const rec = await su("GET", "/api/collections/posts/records/" + postId);
  assert.equal(rec.json.caption, "");
  assert.equal(rec.json.deleted, true);
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

test("each playlist is created once, and friends get the three links", async () => {
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
  const links = await as("ben").get("/api/cymbal/playlists");
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
  const card = (await as("ben").get("/api/cymbal/feed")).json.posts.find((x) => x.id === p.id);
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
  const friend = (await as("ben").get("/api/cymbal/feed")).json.posts.find((x) => x.id === p.id);
  assert.equal(friend.sync.apple_music.state, "attention");
  const wrong = await as("owner").post("/api/cymbal/owner/syncs/" + all.apple_music.id + "/override", { url: "https://youtu.be/dQw4w9WgXcQ" });
  assert.equal(wrong.status, 400);
  assert.equal((await as("ben").post("/api/cymbal/owner/syncs/" + all.apple_music.id + "/override", { url: "https://music.apple.com/gb/song/x/1000000001" })).status, 403);
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

test("friends see states, never match evidence or provider detail", async () => {
  const r = await as("ben").get("/api/cymbal/feed");
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
