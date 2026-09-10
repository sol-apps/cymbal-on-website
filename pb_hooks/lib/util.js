/// <reference path="../../pb_data/types.d.ts" />
/*
 * lib/util.js — what every route and the worker share: time, text, ids, the writer's
 * browser key, secrets, rate limits and provider endpoints.
 *
 * Handlers run in isolated pooled VMs, so nothing at the top of a .pb.js file is
 * visible inside a handler; this module is require()d inside each one instead.
 */

const PROVIDERS = ["spotify", "apple_music", "youtube"];
const LABELS = { spotify: "Spotify", apple_music: "Apple Music", youtube: "YouTube" };

// Control characters other than tab and newline. Built from char codes so the source
// file itself stays plain ASCII.
const CONTROL = (function () {
  const c = String.fromCharCode;
  return new RegExp("[" + c(0) + "-" + c(8) + c(11) + c(12) + c(14) + "-" + c(31) + c(127) + "]", "g");
})();

// PocketBase stores and filters dates as "YYYY-MM-DD HH:MM:SS.sssZ".
function pbTime(ms) {
  return new Date(ms).toISOString().replace("T", " ");
}

function parseTime(s) {
  if (!s) return 0;
  const t = Date.parse(String(s).replace(" ", "T"));
  return isNaN(t) ? 0 : t;
}

// Plain text in, plain text out. Rendering is always textContent in the browser, so
// nothing here escapes HTML; it only refuses what is not text at all.
function cleanText(value, max, label) {
  const t = String(value == null ? "" : value).replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();
  if (t.length > max) throw new BadRequestError(label + " can be at most " + max + " characters.");
  return t;
}

function requestId(value) {
  const id = String(value == null ? "" : value).trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new BadRequestError("Missing or malformed request_id.");
  return id;
}

// The name a writer typed. It is a label, not an identity: nothing checks it.
function pseudonym(value) {
  const name = cleanText(value, 32, "A name").replace(/\s+/g, " ");
  if (name.length < 2) throw new BadRequestError("Pick a name of at least 2 characters.");
  return name;
}

// The browser's private key, sent as X-Cymbal-Key. Only its sha256 is stored; it is
// what proves "this browser wrote that" when someone removes their own post.
function writerKey(e, required) {
  const key = String(e.request.header.get("X-Cymbal-Key") || "");
  if (!key) {
    if (required) throw new BadRequestError("Your browser key is missing. Reload the page and try again.");
    return "";
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) throw new BadRequestError("Your browser key is malformed. Reload the page.");
  return $security.sha256(key);
}

// A salted hash of the client address, for rate limits only. Behind Cloudflare,
// CF-Connecting-IP is the client; if the origin were reached directly it could be
// forged, which would only loosen a rate limit, never grant anything.
function ipHash(e) {
  let ip = String(e.request.header.get("CF-Connecting-IP") || "");
  if (!ip) {
    try { ip = String(e.realIP() || ""); } catch (_) { ip = ""; }
  }
  return ip ? $security.sha256("cymbal-ip:" + tokenKey() + ":" + ip) : "";
}

function isOwner(e) {
  return !!e.auth && e.auth.collection().name === "users" && e.auth.getString("role") === "admin";
}

function requireOwner(e) {
  if (!isOwner(e)) throw new ForbiddenError("Only the owner can do that.");
}

function env(name, fallback) {
  const v = $os.getenv(name);
  return v ? v : (fallback || "");
}

function localMode() {
  return $os.getenv("GREENLIGHT_IDENTITY_MODE") === "local";
}

// Tokens at rest. $security.encrypt is AES-GCM and needs exactly 32 characters of key.
function tokenKey() {
  const k = $os.getenv("CYMBAL_TOKEN_KEY");
  if (!k || k.length !== 32) throw new Error("CYMBAL_TOKEN_KEY must be set to exactly 32 characters");
  return k;
}

function seal(plain) {
  return plain ? $security.encrypt(String(plain), tokenKey()) : "";
}

function unseal(sealed) {
  return sealed ? $security.decrypt(String(sealed), tokenKey()) : "";
}

// Provider endpoints. The test mock can replace them, but ONLY on an instance that
// is explicitly in local identity mode: a production instance cannot be pointed
// anywhere else by configuration.
const BASES = {
  spotify_api: "https://api.spotify.com/v1",
  spotify_accounts: "https://accounts.spotify.com",
  youtube_api: "https://www.googleapis.com/youtube/v3",
  google_token: "https://oauth2.googleapis.com",
  google_auth: "https://accounts.google.com",
  apple_api: "https://api.music.apple.com/v1",
  musicbrainz: "https://musicbrainz.org/ws/2",
  itunes: "https://itunes.apple.com",
};

function base(key) {
  if (localMode()) {
    const mock = $os.getenv("CYMBAL_MOCK_BASE");
    if (mock) return mock.replace(/\/+$/, "") + "/" + key;
  }
  return BASES[key];
}

function publicUrl() {
  return env("CYMBAL_PUBLIC_URL", "https://cymbal-on-website.solhann.net").replace(/\/+$/, "");
}

function storefront() {
  const s = env("CYMBAL_APPLE_STOREFRONT", "gb").toLowerCase();
  return /^[a-z]{2}$/.test(s) ? s : "gb";
}

function spotifyMarket() {
  const s = env("CYMBAL_SPOTIFY_MARKET", "GB").toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : "GB";
}

// Fails closed: Spotify metadata is used to match other catalogues only while the
// owner has explicitly recorded that the provider terms allow it.
function spotifyTransferAllowed() {
  return $os.getenv("CYMBAL_SPOTIFY_METADATA_TRANSFER") === "allowed";
}

// Counts deleted rows too: deleting a post must not buy another one. `field` is
// always a column name from this code, never from a request.
function enforceRate(app, collection, field, value, limit, message) {
  if (!value) return;
  const since = pbTime(Date.now() - 3600 * 1000);
  const n = app.countRecords(collection,
    $dbx.exp(field + " = {:v} AND created >= {:s}", { v: value, s: since }));
  if (n >= limit) throw new TooManyRequestsError(message);
}

function findOne(app, collection, filter, params) {
  try {
    return app.findFirstRecordByFilter(collection, filter, params || {});
  } catch (_) {
    return null;
  }
}

module.exports = {
  PROVIDERS: PROVIDERS,
  LABELS: LABELS,
  pbTime: pbTime,
  parseTime: parseTime,
  cleanText: cleanText,
  requestId: requestId,
  pseudonym: pseudonym,
  writerKey: writerKey,
  ipHash: ipHash,
  isOwner: isOwner,
  requireOwner: requireOwner,
  env: env,
  localMode: localMode,
  seal: seal,
  unseal: unseal,
  base: base,
  publicUrl: publicUrl,
  storefront: storefront,
  spotifyMarket: spotifyMarket,
  spotifyTransferAllowed: spotifyTransferAllowed,
  enforceRate: enforceRate,
  findOne: findOne,
};
