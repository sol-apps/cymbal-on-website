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

test("setup: a superuser, the owner's session, one non-owner session, and seven people", async () => {
  const r = await call("POST", "/api/collections/_superusers/auth-with-password", {
    body: { identity: process.env.SU_EMAIL, password: process.env.SU_PASS },
  });
  assert.equal(r.status, 200, r.text);
  SU = r.json.token;
  const owner = await account("owner", "admin");
  const member = await account("member", "user");
  U.owner = { name: "Sol", key: newKey(), ip: "198.51.100.1", token: owner.token, id: owner.id };
  U.member = { name: "Mem", key: newKey(), ip: "198.51.100.9", token: member.token, id: member.id };
  ["ann", "ben", "cat", "dan", "eve", "fay"].forEach((n, i) => {
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
  for (const c of ["posts", "comments", "playlist_syncs", "playlist_memberships", "provider_connections", "oauth_states", "stickers", "listens", "sticker_kinds", "profiles", "signups"]) {
    for (const token of [U.member.token, U.owner.token, ""]) {
      const list = await call("GET", "/api/collections/" + c + "/records", { token });
      assert.equal(list.status, 403, c + " list -> " + list.status);
      const create = await call("POST", "/api/collections/" + c + "/records", { token, body: { caption: "x" } });
      assert.equal(create.status, 403, c + " create -> " + create.status);
    }
  }
});

test("identity: a signed-in person cannot make themselves owner, nor sign up through the collection API", async () => {
  const r = await call("PATCH", "/api/collections/users/records/" + U.member.id, { token: U.member.token, body: { role: "admin" } });
  assert.notEqual(r.status, 200);
  const me = await su("GET", "/api/collections/users/records/" + U.member.id);
  assert.equal(me.json.role, "user");
  for (const token of ["", U.member.token]) {
    const signup = await call("POST", "/api/collections/users/records", { token, body: { email: "x@cymbal.invalid", password: "abcdefgh1", passwordConfirm: "abcdefgh1", role: "admin" } });
    assert.notEqual(signup.status, 200, "no self-service accounts");
  }
});

test("sign-up: anyone makes an account and is signed in to it, never as the owner", async () => {
  const ip = "203.0.113.50";
  const email = "newbie-" + crypto.randomBytes(4).toString("hex") + "@cymbal.invalid";
  const bad = [
    [{ email: "nope", password: "long-enough-1", name: "Nia" }, 400],
    [{ email, password: "short", name: "Nia" }, 400],
    [{ email, password: "long-enough-1", name: "N" }, 400],
  ];
  for (const [body, status] of bad) assert.equal((await call("POST", "/api/cymbal/signup", { ip, body })).status, status, JSON.stringify(body));

  const made = await call("POST", "/api/cymbal/signup", { ip, body: { email, password: "long-enough-1", name: "Nia", role: "admin" } });
  assert.equal(made.status, 200, made.text);
  assert.ok(made.json.token);
  assert.equal(made.json.record.role, "user", "sign-up never makes an owner");
  assert.equal(made.json.record.name, "Nia");
  assert.equal((await call("GET", "/api/cymbal/owner/status", { token: made.json.token })).status, 403);
  const login = await call("POST", "/api/collections/users/auth-with-password", { body: { identity: email, password: "long-enough-1" } });
  assert.equal(login.status, 200, "and can sign in again later");

  const again = await call("POST", "/api/cymbal/signup", { ip, body: { email: email.toUpperCase(), password: "long-enough-1", name: "Nia" } });
  assert.equal(again.status, 400, "one account per email");
  assert.match(again.json.message, /already/);

  for (let i = 0; i < 4; i++) {
    const r = await call("POST", "/api/cymbal/signup", { ip, body: { email: "flood" + i + "-" + email, password: "long-enough-1", name: "Flood" } });
    assert.equal(r.status, 200, r.text);
  }
  const sixth = await call("POST", "/api/cymbal/signup", { ip, body: { email: "flood9-" + email, password: "long-enough-1", name: "Flood" } });
  assert.equal(sixth.status, 429, "five new accounts an hour per network");
  assert.ok(!made.text.includes("signup_ip") && !made.text.includes("password"));
});

test("identity: the owner signs in with a PocketBase password; there is no SSO", async () => {
  const methods = await call("GET", "/api/collections/users/auth-methods");
  assert.equal(methods.status, 200, methods.text);
  assert.equal(methods.json.password.enabled, true);
  assert.equal(methods.json.oauth2.enabled, false);
  assert.equal((methods.json.oauth2.providers || []).length, 0);

  const made = {};
  for (const [name, role] of [["pwowner", "admin"], ["pwmember", "user"]]) {
    const email = name + "@cymbal.invalid";
    const pw = "pw-" + crypto.randomBytes(9).toString("hex");
    const c = await su("POST", "/api/collections/users/records", { email, password: pw, passwordConfirm: pw, name, role });
    assert.equal(c.status, 200, c.text);
    const login = await call("POST", "/api/collections/users/auth-with-password", { body: { identity: email, password: pw } });
    assert.equal(login.status, 200, login.text);
    assert.equal(login.json.record.role, role);
    made[name] = login.json.token;
  }
  assert.equal((await call("GET", "/api/cymbal/owner/status", { token: made.pwowner })).status, 200, "password-signed-in admin");
  assert.equal((await call("GET", "/api/cymbal/owner/status", { token: made.pwmember })).status, 403, "password-signed-in non-admin");
  assert.equal((await call("GET", "/api/cymbal/owner/status")).status, 401, "anonymous");

  const wrong = await call("POST", "/api/collections/users/auth-with-password", { body: { identity: "pwowner@cymbal.invalid", password: "not-it" } });
  assert.equal(wrong.status, 400);
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
    "https://someartist.bandcamp.com/album/some-album",
    "https://someartist.bandcamp.com/",
    "https://daily.bandcamp.com/track/x",
    "https://bandcamp.com/track/x",
    "https://a.b.bandcamp.com/track/x",
    "https://bandcamp.com.evil.example/track/x",
    "https://someartist.bandcamp.com:8098/track/x",
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
  assert.equal(p.can_delete, false, "only the owner removes posts");
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
  assert.equal((await as("owner").del("/api/cymbal/posts/" + mine[0].id)).status, 200);
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

test("only the owner removes a post or comment", async () => {
  const postId = P.annFirst.id;
  assert.equal((await as("ben").del("/api/cymbal/posts/" + postId)).status, 403);
  assert.equal((await as("ann").del("/api/cymbal/posts/" + postId)).status, 403, "not even the browser that wrote it");
  assert.equal((await as("ben").del("/api/cymbal/comments/" + P.benComment)).status, 403, "nor a comment's writer");
  assert.equal((await call("DELETE", "/api/cymbal/posts/" + postId)).status, 403, "no key, no session");
  assert.equal((await call("DELETE", "/api/cymbal/posts/" + postId, { token: U.member.token })).status, 403, "a non-owner session");
  assert.equal((await as("ann").del("/api/cymbal/comments/" + P.benComment)).status, 403);
  assert.equal((await as("owner").del("/api/cymbal/comments/" + P.benComment)).status, 200, "the owner moderates comments");
  assert.equal((await as("owner").del("/api/cymbal/posts/" + P.benBohemian.id)).status, 200, "the owner moderates posts");
  const ownerView = (await as("owner").get("/api/cymbal/feed")).json.posts;
  assert.ok(ownerView.every((p) => p.can_delete === true), "the owner can remove anything");
  const annView = (await as("ann").get("/api/cymbal/feed")).json.posts;
  assert.ok(annView.every((p) => p.can_delete === false), "nobody else can remove anything");
  assert.equal((await as("owner").del("/api/cymbal/posts/" + postId)).status, 200);
  const feed = await as("ben").get("/api/cymbal/feed");
  assert.ok(!feed.json.posts.some((p) => p.id === postId));
  assert.equal((await as("ben").get("/api/cymbal/posts/" + postId + "/comments")).status, 404);
  const rec = await su("GET", "/api/collections/posts/records/" + postId);
  assert.equal(rec.json.caption, "");
  assert.equal(rec.json.deleted, true);
  assert.equal(rec.json.deleted_by, "admin");
  const all = await rows(postId);
  assert.ok(Object.values(all).every((r) => r.status === "cancelled" || r.status === "synced"));
});

test("stickers: everyone sees them; anyone places one per post and moves only their own", async () => {
  const post = await share("cat", "https://open.spotify.com/track/" + randomSpotifyId(), "stick something on this");
  const path = "/api/cymbal/posts/" + post.id + "/stickers";
  assert.equal((await call("POST", path, { ip: U.nokey.ip, body: { kind: "heart", x: 0.5, y: 10 } })).status, 400, "no session and no browser key");

  const heart = await as("owner").post(path, { kind: "heart", x: 0.25, y: 40, rot: -8 });
  assert.equal(heart.status, 200, heart.text);
  assert.deepEqual(Object.keys(heart.json.sticker).sort(), ["id", "kind", "mine", "rot", "x", "y"]);
  assert.equal((await as("owner").post(path, { kind: "skull", x: 0.5, y: 1 })).status, 400);
  assert.equal((await as("owner").post(path, { kind: "heart", x: "left", y: 1 })).status, 400);
  assert.equal((await as("owner").post("/api/cymbal/posts/aaaaaaaaaaaaaaa/stickers", { kind: "heart", x: 0, y: 0 })).status, 404);

  // One each per post: a second one takes the first one's place.
  const star = await as("owner").post(path, { kind: "star", x: 7, y: -3, rot: 99 });
  assert.equal(star.status, 200, star.text);
  assert.equal(star.json.sticker.id, heart.json.sticker.id, "the same sticker, swapped");
  assert.deepEqual([star.json.sticker.x, star.json.sticker.y, star.json.sticker.rot], [1, 0, 30], "clamped onto the card");
  const other = await share("ann", "https://open.spotify.com/track/" + randomSpotifyId(), "and on this");
  const second = await as("owner").post("/api/cymbal/posts/" + other.id + "/stickers", { kind: "heart", x: 0.5, y: 20 });
  assert.equal(second.status, 200, second.text);
  assert.notEqual(second.json.sticker.id, star.json.sticker.id, "another post has its own");

  const mine = (await as("owner").get("/api/cymbal/feed")).json.posts.find((p) => p.id === post.id);
  assert.deepEqual(mine.stickers.map((s) => [s.kind, s.mine]), [["star", true]]);
  for (const r of [await as("ann").get("/api/cymbal/feed"), await as("cat").get("/api/cymbal/feed"),
    await call("GET", "/api/cymbal/feed", { token: U.member.token }), await call("GET", "/api/cymbal/feed", {})]) {
    const seen = r.json.posts.find((p) => p.id === post.id);
    assert.deepEqual(seen.stickers.map((s) => [s.kind, s.x, s.mine]), [["star", 1, false]], "everyone sees it, nobody else can move it");
    assert.ok(!r.text.includes("author_key"));
  }

  // A member gets their own one, alongside the owner's, and it's theirs to move.
  const theirs = await call("POST", path, { token: U.member.token, body: { kind: "heart", x: 0.5, y: 10 } });
  assert.equal(theirs.status, 200, theirs.text);
  assert.notEqual(theirs.json.sticker.id, star.json.sticker.id);
  const swap = await call("POST", path, { token: U.member.token, body: { kind: "star", x: 0.6, y: 12 } });
  assert.equal(swap.json.sticker.id, theirs.json.sticker.id, "one each for members too");
  const memberSees = (await call("GET", "/api/cymbal/feed", { token: U.member.token })).json.posts.find((p) => p.id === post.id);
  assert.deepEqual(memberSees.stickers.map((s) => s.mine), [false, true]);
  const theirMove = "/api/cymbal/stickers/" + theirs.json.sticker.id + "/move";
  assert.equal((await call("POST", theirMove, { token: U.member.token, body: { x: 0.1, y: 5 } })).status, 200);
  assert.equal((await as("owner").post(theirMove, { x: 0.1, y: 5 })).status, 403, "not even the owner moves someone else's");
  assert.equal((await call("DELETE", "/api/cymbal/stickers/" + theirs.json.sticker.id, { token: U.member.token })).status, 200, "and they can take it back");

  const moveTo = "/api/cymbal/stickers/" + star.json.sticker.id + "/move";
  assert.equal((await call("POST", moveTo, { token: U.member.token, body: { x: 0.9, y: 5 } })).status, 403);
  assert.equal((await call("POST", moveTo, { key: U.ann.key, body: { x: 0.9, y: 5 } })).status, 403, "signed out, still not yours");
  const moved = await as("owner").post(moveTo, { x: 0.9, y: 120, rot: 4 });
  assert.equal(moved.status, 200, moved.text);
  assert.deepEqual([moved.json.sticker.x, moved.json.sticker.y, moved.json.sticker.rot], [0.9, 120, 4]);

  const gone = "/api/cymbal/stickers/" + second.json.sticker.id;
  assert.equal((await call("DELETE", gone, { token: U.member.token })).status, 403);
  assert.equal((await as("owner").del(gone)).status, 200);
  assert.equal((await as("owner").del(gone)).status, 404);
  const after = (await as("owner").get("/api/cymbal/feed")).json.posts;
  assert.deepEqual(after.find((p) => p.id === post.id).stickers.map((s) => [s.kind, s.x, s.y]), [["star", 0.9, 120]]);
  assert.deepEqual(after.find((p) => p.id === other.id).stickers, []);

  // Signed out, a browser gets one each too, filed under its key, and it's that
  // browser's to move or take back.
  const anns = await as("ann").post(path, { kind: "heart", x: 0.3, y: 30 });
  assert.equal(anns.status, 200, anns.text);
  assert.equal(anns.json.sticker.mine, true);
  assert.equal((await as("ann").post(path, { kind: "star", x: 0.4, y: 30 })).json.sticker.id, anns.json.sticker.id, "one each per browser");
  const theirOwn = await as("ben").post(path, { kind: "heart", x: 0.2, y: 50 });
  assert.notEqual(theirOwn.json.sticker.id, anns.json.sticker.id, "another browser has its own");
  const annSees = (await as("ann").get("/api/cymbal/feed")).json.posts.find((p) => p.id === post.id);
  assert.deepEqual(annSees.stickers.map((s) => [s.id === anns.json.sticker.id, s.mine]), [[false, false], [true, true], [false, false]]);
  const annMove = "/api/cymbal/stickers/" + anns.json.sticker.id;
  assert.equal((await as("ben").post(annMove + "/move", { x: 0.1, y: 5 })).status, 403);
  assert.equal((await call("POST", annMove + "/move", { token: U.member.token, body: { x: 0.1, y: 5 } })).status, 403);
  assert.equal((await as("ann").post(annMove + "/move", { x: 0.1, y: 5 })).status, 200);
  assert.equal((await as("ann").del(annMove)).status, 200);
});

test("listens: once per browser per post, counted for everyone", async () => {
  const post = await share("cat", "https://open.spotify.com/track/" + randomSpotifyId(), "have a listen");
  const path = "/api/cymbal/posts/" + post.id + "/listen";
  assert.equal(post.listen_count, 0);
  assert.equal((await call("POST", path, { ip: U.nokey.ip, body: {} })).status, 400, "a browser key is needed");
  assert.equal((await as("ann").post(path)).json.counted, true);
  assert.equal((await as("ann").post(path)).json.counted, false, "the same browser again");
  assert.equal((await as("ben").post(path)).json.counted, true);
  assert.equal((await as("ann").post("/api/cymbal/posts/aaaaaaaaaaaaaaa/listen")).status, 404);
  const seen = (await call("GET", "/api/cymbal/feed")).json.posts.find((p) => p.id === post.id);
  assert.equal(seen.listen_count, 2);
  for (const token of [U.member.token, U.owner.token, ""]) {
    assert.equal((await call("GET", "/api/collections/listens/records", { token })).status, 403);
  }
});

test("the feed carries the first three comments, and whether an account posted", async () => {
  const post = await share("eve", "https://open.spotify.com/track/" + randomSpotifyId(), "talk amongst yourselves");
  for (let i = 1; i <= 5; i++) {
    const r = await as(i % 2 ? "ann" : "ben").post("/api/cymbal/posts/" + post.id + "/comments", { body: "comment " + i, name: "C" + i, request_id: rid() });
    assert.equal(r.status, 200, r.text);
  }
  const seen = (await as("ann").get("/api/cymbal/feed")).json.posts.find((p) => p.id === post.id);
  assert.deepEqual(seen.comments.map((c) => c.body), ["comment 1", "comment 2", "comment 3"]);
  assert.deepEqual(seen.comments.map((c) => c.mine), [true, false, true]);
  assert.equal(seen.comment_count, 5);
  assert.equal(seen.account, false);
  const r = await as("owner").post("/api/cymbal/posts", { url: "https://open.spotify.com/track/" + randomSpotifyId(), name: "Sol", caption: "", request_id: rid() });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.post.account, true, "the owner posted while signed in");
  assert.ok(!JSON.stringify(r.json).includes(U.owner.id), "never says which account");
});

test("sticker uploads: anyone submits a few PNGs, signed-out ones wait for the owner, only the owner removes one", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const upload = async (token, label, bytes, type, key, ip) => {
    const fd = new FormData();
    fd.append("label", label);
    fd.append("image", new Blob([bytes], { type }), "s.png");
    const headers = token ? { Authorization: token } : {};
    if (key) headers["X-Cymbal-Key"] = key;
    if (ip) headers["CF-Connecting-IP"] = ip;
    const res = await fetch(BASE + "/api/cymbal/sticker-kinds", { method: "POST", headers, body: fd });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  assert.equal((await upload("", "Moon", png, "image/png")).status, 400, "signed out, a browser key is needed");
  assert.equal((await upload(U.owner.token, "Moon", Buffer.from("not a png"), "text/plain")).status, 400);
  const moon = await upload(U.owner.token, "Moon", png, "image/png");
  assert.equal(moon.status, 200, JSON.stringify(moon.json));
  const kind = moon.json.kind;
  assert.match(kind.id, /^u_[a-z0-9]{15}$/);

  // A member gets three; the owner has no such limit.
  for (const n of [1, 2, 3]) assert.equal((await upload(U.member.token, "Mem " + n, png, "image/png")).status, 200);
  const fourth = await upload(U.member.token, "Mem 4", png, "image/png");
  assert.equal(fourth.status, 400, "three each");
  assert.match(fourth.json.message, /3 stickers/);
  assert.equal((await upload(U.owner.token, "Sun", png, "image/png")).status, 200);

  const kinds = (await call("GET", "/api/cymbal/sticker-kinds")).json.kinds;
  assert.deepEqual(kinds.map((k) => k.id).slice(0, 2), ["heart", "star"]);
  const listed = kinds.find((k) => k.id === kind.id);
  assert.equal(listed.label, "Moon");
  assert.ok(!JSON.stringify(kinds).includes(U.member.id), "nobody can tell who submitted what");
  const img = await fetch(BASE + listed.src);
  assert.equal(img.status, 200, "anyone can load the image");

  const post = await share("fay", "https://open.spotify.com/track/" + randomSpotifyId(), "moonlight");
  const stuck = await as("owner").post("/api/cymbal/posts/" + post.id + "/stickers", { kind: kind.id, x: 0.5, y: 30 });
  assert.equal(stuck.status, 200, stuck.text);
  assert.equal(stuck.json.sticker.kind, kind.id);
  assert.equal((await as("owner").post("/api/cymbal/posts/" + post.id + "/stickers", { kind: "u_aaaaaaaaaaaaaaa", x: 0.5, y: 30 })).status, 400);

  // Most reacts is the owner's alone.
  const old = await call("GET", "/api/cymbal/leaderboard");
  assert.ok(!(old.json && old.json.posts), "the old public path is gone");
  assert.equal((await call("GET", "/api/cymbal/owner/leaderboard")).status, 401);
  assert.equal((await call("GET", "/api/cymbal/owner/leaderboard", { token: U.member.token })).status, 403);
  const board = await as("owner").get("/api/cymbal/owner/leaderboard");
  assert.equal(board.status, 200, board.text);
  const row = board.json.posts.find((p) => p.id === post.id);
  assert.deepEqual([row.reacts, row.kinds[kind.id]], [1, 1]);
  assert.ok(!board.text.includes("author_key") && !board.text.includes("ip_hash"));

  // Auto approval: only the owner reads or switches it, and it starts on.
  const autoPath = "/api/cymbal/owner/sticker-approval";
  assert.equal((await call("GET", autoPath, {})).status, 401);
  assert.equal((await call("GET", autoPath, { token: U.member.token })).status, 403);
  assert.equal((await call("POST", autoPath, { token: U.member.token, body: { auto: false } })).status, 403);
  assert.equal((await as("owner").get(autoPath)).json.auto, true);
  assert.equal((await call("GET", "/api/cymbal/sticker-kinds")).json.auto_approve, true);
  assert.equal((await as("owner").post(autoPath, { auto: "no" })).status, 400);
  const annKey = U.ann.key, annIp = U.ann.ip;
  const straight = await upload("", "Rocket", png, "image/png", newKey(), "198.51.100.77");
  assert.equal(straight.status, 200, JSON.stringify(straight.json));
  assert.equal(straight.json.kind.waiting, false, "auto approval on: live straight away");
  assert.ok((await call("GET", "/api/cymbal/sticker-kinds")).json.kinds.some((k) => k.id === straight.json.kind.id));
  assert.equal((await as("owner").del("/api/cymbal/owner/sticker-kinds/" + straight.json.kind.id)).status, 200);

  // Off: signed out, it waits, unseen and unstickable, until the owner approves it.
  const off = await as("owner").post(autoPath, { auto: false });
  assert.deepEqual([off.status, off.json.auto], [200, false]);
  assert.equal((await as("owner").get(autoPath)).json.auto, false);
  assert.equal((await call("GET", "/api/cymbal/sticker-kinds")).json.auto_approve, false);
  const cometPost = await share("fay", "https://open.spotify.com/track/" + randomSpotifyId(), "comet");
  const sent = await upload("", "Comet", png, "image/png", annKey, annIp);
  assert.equal(sent.status, 200, JSON.stringify(sent.json));
  assert.equal(sent.json.kind.waiting, true);
  const comet = sent.json.kind.id;
  assert.ok(!(await call("GET", "/api/cymbal/sticker-kinds")).json.kinds.some((k) => k.id === comet), "not listed yet");
  assert.equal((await as("ann").post("/api/cymbal/posts/" + cometPost.id + "/stickers", { kind: comet, x: 0.5, y: 30 })).status, 400, "can't be stuck yet");
  for (const n of [2, 3]) assert.equal((await upload("", "Comet " + n, png, "image/png", annKey, annIp)).status, 200);
  assert.equal((await upload("", "Comet 4", png, "image/png", annKey, annIp)).status, 400, "three each per browser");
  const waitPath = "/api/cymbal/owner/sticker-kinds/waiting";
  assert.equal((await call("GET", waitPath, { token: U.member.token })).status, 403);
  assert.equal((await call("GET", waitPath, {})).status, 401);
  const waiting = await as("owner").get(waitPath);
  assert.deepEqual(waiting.json.kinds.map((k) => k.label), ["Comet", "Comet 2", "Comet 3"]);
  assert.equal((await call("POST", "/api/cymbal/owner/sticker-kinds/" + comet + "/approve", { token: U.member.token })).status, 403);
  const ok = await as("owner").post("/api/cymbal/owner/sticker-kinds/" + comet + "/approve");
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await as("owner").post("/api/cymbal/owner/sticker-kinds/" + comet + "/approve")).status, 404, "only once");
  assert.ok((await call("GET", "/api/cymbal/sticker-kinds")).json.kinds.some((k) => k.id === comet), "listed once approved");
  assert.equal((await as("ann").post("/api/cymbal/posts/" + cometPost.id + "/stickers", { kind: comet, x: 0.5, y: 30 })).status, 200);
  const turnedDown = waiting.json.kinds[1].id;
  assert.equal((await as("owner").del("/api/cymbal/owner/sticker-kinds/" + turnedDown)).status, 200);
  assert.deepEqual((await as("owner").get(waitPath)).json.kinds.map((k) => k.label), ["Comet 3"]);
  assert.equal((await as("owner").post(autoPath, { auto: true })).json.auto, true);
  assert.deepEqual((await as("owner").get(waitPath)).json.kinds.map((k) => k.label), ["Comet 3"], "switching on leaves waiting ones");

  const theirs = kinds.find((k) => k.label === "Mem 1");
  assert.equal((await call("DELETE", "/api/cymbal/owner/sticker-kinds/" + theirs.id, { token: U.member.token })).status, 403, "not even your own");
  for (const k of kinds.filter((k) => k.uploaded && k.id !== kind.id)) {
    assert.equal((await as("owner").del("/api/cymbal/owner/sticker-kinds/" + k.id)).status, 200);
  }
  assert.equal((await as("owner").del("/api/cymbal/owner/sticker-kinds/" + kind.id)).status, 200);
  assert.equal((await as("owner").del("/api/cymbal/owner/sticker-kinds/" + kind.id)).status, 404);
  const after = (await call("GET", "/api/cymbal/feed")).json.posts.find((p) => p.id === post.id);
  assert.deepEqual(after.stickers, []);
});

test("profile pictures: an account or a browser sets its own, and the posts it makes show it", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const upload = async (who, bytes, type) => {
    const fd = new FormData();
    fd.append("image", new Blob([bytes], { type }), "me.png");
    const headers = { "CF-Connecting-IP": U[who].ip };
    if (U[who].key) headers["X-Cymbal-Key"] = U[who].key;
    if (U[who].token) headers.Authorization = U[who].token;
    const res = await fetch(BASE + "/api/cymbal/me/profile", { method: "POST", headers, body: fd });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  assert.equal((await call("GET", "/api/cymbal/me/profile", { ip: U.nokey.ip })).status, 400, "signed out, a browser key is needed");
  assert.equal((await upload("member", Buffer.from("nope"), "text/plain")).status, 400);
  assert.equal((await as("member").get("/api/cymbal/me/profile")).json.pic, "");
  const set = await upload("member", png, "image/png");
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.match(set.json.pic, /^\/api\/files\/profiles\/[a-z0-9]{15}\//);
  assert.equal((await fetch(BASE + set.json.pic)).status, 200);
  assert.equal((await upload("member", png, "image/png")).status, 429, "not again straight away");
  assert.equal((await as("member").get("/api/cymbal/me/profile")).json.pic, set.json.pic);
  assert.equal((await as("owner").get("/api/cymbal/me/profile")).json.pic, "", "another account has its own");

  const signedIn = await share("member", "https://open.spotify.com/track/" + randomSpotifyId(), "with a face");
  // The same browser, signed out: no picture, because the picture is the account's.
  const signedOut = await call("POST", "/api/cymbal/posts", { key: U.member.key, ip: U.member.ip, body: { url: spUrl(randomSpotifyId()), name: "Mem", request_id: rid() } });
  assert.equal(signedOut.status, 200, signedOut.text);
  let feed = (await call("GET", "/api/cymbal/feed")).json.posts;
  assert.equal(feed.find((p) => p.id === signedIn.id).pic, set.json.pic, "posts made signed in show it");
  assert.equal(feed.find((p) => p.id === signedOut.json.post.id).pic, "", "posts made signed out don't");

  // Signed out, a browser has a picture of its own, on the posts it makes.
  assert.equal((await as("ann").get("/api/cymbal/me/profile")).json.pic, "");
  const annPic = await upload("ann", png, "image/png");
  assert.equal(annPic.status, 200, JSON.stringify(annPic.json));
  assert.notEqual(annPic.json.pic, set.json.pic);
  assert.equal((await as("ann").get("/api/cymbal/me/profile")).json.pic, annPic.json.pic);
  assert.equal((await as("ben").get("/api/cymbal/me/profile")).json.pic, "", "another browser has its own");
  const annPost = await share("ann", spUrl(randomSpotifyId()), "my face");
  feed = (await call("GET", "/api/cymbal/feed")).json.posts;
  assert.equal(feed.find((p) => p.id === annPost.id).pic, annPic.json.pic);
  assert.equal(feed.find((p) => p.id === signedOut.json.post.id).pic, "", "still not on another browser's posts");
  assert.equal((await as("ann").del("/api/cymbal/me/profile")).status, 200);
  assert.equal((await as("ann").get("/api/cymbal/me/profile")).json.pic, "");

  assert.equal((await as("member").del("/api/cymbal/me/profile")).status, 200);
  assert.equal((await as("member").get("/api/cymbal/me/profile")).json.pic, "");
  for (const token of [U.member.token, U.owner.token, ""]) {
    assert.equal((await call("GET", "/api/collections/profiles/records", { token })).status, 403);
  }
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

test("an ambiguous match becomes a flagged guess, and the owner checks or replaces it", async () => {
  const p = await share("ann", spUrl(SP.echo));
  P.four = p.id;
  const all = await drain(p.id);
  assert.equal(all.spotify.status, "synced");
  assert.equal(all.spotify.needs_review, false);
  assert.equal(all.apple_music.status, "pending_device");
  assert.equal(all.apple_music.match_basis, "guess");
  assert.equal(all.apple_music.needs_review, true);
  assert.equal(all.apple_music.target_id, "1000000001", "the first of two equal candidates");
  assert.equal(all.apple_music.evidence.guess.instead_of, "ambiguous");
  assert.equal(all.youtube.status, "attention", "nothing to guess from: the search found nothing");
  assert.equal(all.youtube.reason, "no_match");

  const review = await as("owner").get("/api/cymbal/owner/syncs?status=review");
  const item = review.json.syncs.find((s) => s.id === all.apple_music.id);
  assert.ok(item, review.text);
  assert.equal(item.guess.confidence, "unsure");
  assert.equal(item.picked.title, "Echo Chamber");
  assert.equal((await call("POST", "/api/cymbal/owner/syncs/" + all.apple_music.id + "/confirm", { token: U.member.token })).status, 403);

  const wrong = await as("owner").post("/api/cymbal/owner/syncs/" + all.apple_music.id + "/override", { url: "https://youtu.be/dQw4w9WgXcQ" });
  assert.equal(wrong.status, 400);
  assert.equal((await call("POST", "/api/cymbal/owner/syncs/" + all.apple_music.id + "/override", { token: U.member.token, body: { url: "https://music.apple.com/gb/song/x/1000000002" } })).status, 403);
  const fix = await as("owner").post("/api/cymbal/owner/syncs/" + all.apple_music.id + "/override", { url: "https://music.apple.com/gb/song/echo-chamber/1000000002" });
  assert.equal(fix.status, 200, fix.text);
  const after = await rows(p.id);
  assert.equal(after.apple_music.status, "pending_device");
  assert.equal(after.apple_music.target_id, "1000000002");
  assert.equal(after.apple_music.match_basis, "manual");
  assert.equal(after.apple_music.needs_review, false);
  const again = await as("owner").get("/api/cymbal/owner/syncs?status=review");
  assert.ok(!again.json.syncs.some((s) => s.id === all.apple_music.id));
  assert.equal((await as("owner").post("/api/cymbal/owner/syncs/" + all.apple_music.id + "/confirm", {})).status, 400);
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

test("the owner can take the closest candidate even below the bar for a guess", async () => {
  const before = await rows(P.five);
  const list = await as("owner").get("/api/cymbal/owner/syncs?status=attention");
  const apple = list.json.syncs.find((s) => s.id === before.apple_music.id);
  assert.ok(apple && apple.closest, list.text);
  assert.equal(apple.closest.id, "1000000003", "the studio take, shown though a guess never crosses live to studio");
  assert.ok(apple.closest.notes.some((n) => n.startsWith("version")));
  const yt = list.json.syncs.find((s) => s.id === before.youtube.id);
  assert.equal(yt.closest.id, "SongCstudio");

  const path = "/api/cymbal/owner/syncs/" + before.youtube.id + "/pick";
  assert.equal((await call("POST", path, { token: U.member.token, body: {} })).status, 403);
  assert.equal((await as("owner").post(path, { candidate_id: "notSeenHere" })).status, 400);
  const res = await as("owner").post(path, {});
  assert.equal(res.status, 200, res.text);
  const after = (await rows(P.five)).youtube;
  assert.equal(after.status, "pending");
  assert.equal(after.target_id, "SongCstudio");
  assert.equal(after.match_basis, "manual");
  assert.equal(after.needs_review, false);
  assert.equal((await drain(P.five)).youtube.status, "synced");
  assert.equal((await as("owner").post(path, {})).status, 400, "only rows waiting for a match");
});

test("the owner can dismiss a song that isn't on a service, and bring it back", async () => {
  const row = (await rows(P.four)).youtube;
  assert.equal(row.status, "attention");
  assert.equal((await as("owner").post("/api/cymbal/owner/syncs/" + row.id + "/pick", {})).status, 400, "nothing was found to pick");
  const path = "/api/cymbal/owner/syncs/" + row.id + "/dismiss";
  assert.equal((await call("POST", path, { token: U.member.token })).status, 403);
  const res = await as("owner").post(path, {});
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.remove_url, "");
  let r = (await rows(P.four)).youtube;
  assert.equal(r.status, "cancelled");
  assert.equal(r.reason, "dismissed");
  const list = await as("owner").get("/api/cymbal/owner/syncs?status=attention");
  assert.ok(!list.json.syncs.some((s) => s.id === row.id));
  const gone = await as("owner").get("/api/cymbal/owner/syncs?status=dismissed");
  assert.ok(gone.json.syncs.some((s) => s.id === row.id), gone.text);
  assert.equal((await as("owner").post(path, {})).status, 400, "already dismissed");

  assert.equal((await as("owner").post("/api/cymbal/owner/syncs/" + row.id + "/retry")).status, 200);
  r = (await rows(P.four)).youtube;
  assert.equal(r.status, "pending");
  assert.equal((await drain(P.four)).youtube.status, "attention");
  assert.equal((await as("owner").post(path, {})).status, 200);
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

test("a Bandcamp post reaches all three playlists, and its card gets Bandcamp's player", async () => {
  const p = await share("fay", "https://rickastley.bandcamp.com/track/never-gonna-give-you-up?from=embed");
  assert.equal(p.source, "bandcamp");
  assert.equal(p.source_label, "Bandcamp");
  assert.equal(p.url, "https://rickastley.bandcamp.com/track/never-gonna-give-you-up");
  assert.equal(p.title, "Never Gonna Give You Up");
  assert.equal(p.artist, "Rick Astley");
  assert.equal(p.duration_ms, 214000);
  assert.equal(p.embed_id, "2718281828");
  const all = await drain(p.id);
  assert.equal(Object.keys(all).length, 3, "Bandcamp is a source, never a playlist");
  assert.equal(all.spotify.status, "synced");
  assert.equal(all.spotify.target_id, SP.rick);
  assert.equal(all.youtube.status, "synced");
  assert.equal(all.youtube.target_id, "dQw4w9WgXcQ");
  assert.equal(all.apple_music.status, "pending_device");
  assert.equal(all.apple_music.target_id, "1558533900");
  const page = (await mock("/__log")).log.filter((l) => l.path.startsWith("/bandcamp/"));
  assert.deepEqual(page.map((l) => l.path), ["/bandcamp/rickastley/track/never-gonna-give-you-up"]);

  const old = await share("fay", "https://queen.bandcamp.com/track/bohemian-rhapsody");
  assert.equal(old.title, "Bohemian Rhapsody", "an older page without JSON-LD still resolves");
  assert.equal(old.artist, "Queen & Friends");
  assert.equal(old.embed_id, "3141592653");

  const gone = await share("fay", "https://nobody.bandcamp.com/track/not-a-song");
  const after = (await call("GET", "/api/cymbal/feed")).json.posts.find((x) => x.id === gone.id);
  assert.equal(after.unavailable, true, "a missing track page is a failed lookup, not a retry loop");
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
  const a = await share("eve", "https://music.apple.com/gb/song/echo-chamber/1000000001");
  const claim = await as("owner").post("/api/cymbal/owner/apple/claim", { max: 25 });
  const item = claim.json.items.find((i) => i.catalog_id === "1000000001");
  assert.ok(item);
  assert.equal((await as("owner").del("/api/cymbal/posts/" + a.id)).status, 200);
  assert.equal((await rows(a.id)).apple_music.status, "cancelled");
  await as("owner").post("/api/cymbal/owner/apple/complete", { results: [{ sync_id: item.sync_id, lease: item.lease, outcome: "added" }] });
  assert.equal((await rows(a.id)).apple_music.status, "synced", "it is on the playlist, so the record says so");

  const b = await share("eve", "https://music.apple.com/gb/song/song-c/1000000003");
  assert.equal((await as("owner").del("/api/cymbal/posts/" + b.id)).status, 200);
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
