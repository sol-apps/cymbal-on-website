/// <reference path="../../pb_data/types.d.ts" />
/*
 * lib/providers.js — every outbound call Cymbal makes, and how each failure is read.
 *
 * Only hosts named in lib/util.js BASES are ever contacted, and every URL here is
 * built from ids that lib/urls.js has already validated. Nothing the caller typed is
 * used as a host.
 *
 * Failures are thrown as provider errors with a `kind` the worker acts on:
 *   config     credentials absent: the adapter is disabled, jobs wait
 *   auth       the owner's authorisation is gone: mark needs_reauth, jobs wait
 *   rate       429: provider-wide cooldown for Retry-After
 *   quota      YouTube daily quota: cooldown until the Pacific-time reset
 *   transient  5xx or network: retry with backoff
 *   uncertain  a WRITE whose outcome is unknown: verify the playlist before retrying
 *   not_found  the item does not exist (or is not available in this storefront)
 *   refused    any other 4xx: needs a person
 * Messages carry a status and a short provider code, never a response body.
 */

function util() {
  return require(__hooks + "/lib/util.js");
}

function match() {
  return require(__hooks + "/lib/match.js");
}

function perr(kind, message, extra) {
  const e = new Error(message);
  e.cymbal = true;
  e.kind = kind;
  if (extra) for (const k in extra) e[k] = extra[k];
  return e;
}

// Client ids and secrets are ASCII; Goja has no btoa.
function base64(str) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < str.length; i += 3) {
    const a = str.charCodeAt(i);
    const b = i + 1 < str.length ? str.charCodeAt(i + 1) : NaN;
    const c = i + 2 < str.length ? str.charCodeAt(i + 2) : NaN;
    if (a > 127 || b > 127 || c > 127) throw perr("config", "credential contains non-ASCII characters");
    const n = (a << 16) | ((isNaN(b) ? 0 : b) << 8) | (isNaN(c) ? 0 : c);
    out += chars.charAt((n >> 18) & 63) + chars.charAt((n >> 12) & 63) +
      (isNaN(b) ? "=" : chars.charAt((n >> 6) & 63)) + (isNaN(c) ? "=" : chars.charAt(n & 63));
  }
  return out;
}

function form(obj) {
  return Object.keys(obj).map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k])).join("&");
}

function qs(obj) {
  return Object.keys(obj).filter((k) => obj[k] !== undefined && obj[k] !== "")
    .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(obj[k])).join("&");
}

function header(res, name) {
  const h = res.headers || {};
  const v = h[name] || h[name.toLowerCase()];
  if (!v) return "";
  return Array.isArray(v) ? String(v[0]) : String(v);
}

function retryAfterMs(res) {
  const v = header(res, "Retry-After");
  if (!v) return 0;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return isNaN(at) ? 0 : Math.max(0, at - Date.now());
}

// A short, owner-safe code from an error body: never the body itself.
function providerCode(res) {
  try {
    const j = res.json || {};
    const err = j.error || (j.errors && j.errors[0]) || {};
    if (typeof err === "string") return err.slice(0, 60);
    const reason = err.errors && err.errors[0] && err.errors[0].reason;
    return String(reason || err.status || err.code || err.reason || err.title || "").slice(0, 60);
  } catch (_) {
    return "";
  }
}

// opts: {url, method, headers, body, timeout, write}
function call(opts) {
  let res;
  try {
    res = $http.send({
      url: opts.url,
      method: opts.method || "GET",
      headers: opts.headers || {},
      body: opts.body === undefined ? "" : opts.body,
      timeout: opts.timeout || 15,
    });
  } catch (err) {
    const msg = String(err).slice(0, 160);
    if (opts.write) throw perr("uncertain", "network error during write: " + msg);
    throw perr("transient", "network error: " + msg);
  }
  const status = res.statusCode;
  if (status >= 200 && status < 300) return res;
  const code = providerCode(res);
  const label = "http " + status + (code && code !== String(status) ? " " + code : "");
  if (status === 401) throw perr("auth", label, { status: status });
  if (status === 429) throw perr("rate", label, { status: status, retryAfterMs: retryAfterMs(res) || 30000 });
  if (status === 403 && /quotaExceeded|dailyLimitExceeded/i.test(code)) throw perr("quota", label, { status: status });
  if (status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(code)) {
    throw perr("rate", label, { status: status, retryAfterMs: 60000 });
  }
  if (status >= 500) {
    if (opts.write) throw perr("uncertain", label, { status: status, retryAfterMs: retryAfterMs(res) });
    throw perr("transient", label, { status: status, retryAfterMs: retryAfterMs(res) });
  }
  if (status === 404) throw perr("not_found", label, { status: status });
  throw perr("refused", label, { status: status });
}

function tokenStore(key, value, expiresMs) {
  const store = $app.store();
  if (value === undefined) {
    const v = store.get(key);
    const exp = Number(store.get(key + "_exp") || 0);
    return v && exp > Date.now() + 60000 ? String(v) : "";
  }
  store.set(key, value);
  store.set(key + "_exp", expiresMs);
  return value;
}

// ── owner OAuth tokens (Spotify, Google), sealed in provider_connections ─────

function connection(app, provider) {
  const u = util();
  let row = u.findOne(app, "provider_connections", "provider = {:p}", { p: provider });
  if (!row) {
    row = new Record(app.findCollectionByNameOrId("provider_connections"));
    row.set("provider", provider);
    row.set("status", "disconnected");
    app.save(row);
  }
  return row;
}

function markReauth(app, provider, why) {
  const row = connection(app, provider);
  row.set("status", "needs_reauth");
  row.set("access_token_enc", "");
  row.set("last_error", String(why || "authorisation expired or was revoked").slice(0, 400));
  app.save(row);
}

function storeTokens(app, provider, tok, extra) {
  const u = util();
  const row = connection(app, provider);
  row.set("access_token_enc", u.seal(tok.access_token));
  if (tok.refresh_token) row.set("refresh_token_enc", u.seal(tok.refresh_token));
  row.set("token_expires_at", u.pbTime(Date.now() + (Number(tok.expires_in) || 3600) * 1000));
  if (tok.scope) row.set("scopes", String(tok.scope).slice(0, 500));
  row.set("status", "connected");
  row.set("last_error", "");
  if (extra) for (const k in extra) row.set(k, extra[k]);
  app.save(row);
  return row;
}

function ownerAccessToken(app, provider) {
  const u = util();
  const row = connection(app, provider);
  const st = row.getString("status");
  if (st === "disconnected") throw perr("config", LABEL[provider] + " is not connected");
  if (st === "needs_reauth") throw perr("auth", LABEL[provider] + " needs reconnecting");
  const access = u.unseal(row.getString("access_token_enc"));
  if (access && u.parseTime(row.getString("token_expires_at")) > Date.now() + 60000) return access;
  const refresh = u.unseal(row.getString("refresh_token_enc"));
  if (!refresh) {
    markReauth(app, provider, "no refresh token stored");
    throw perr("auth", LABEL[provider] + " needs reconnecting");
  }
  let tok;
  try {
    tok = provider === "spotify" ? spotify.tokenRequest({ grant_type: "refresh_token", refresh_token: refresh })
      : google.tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });
  } catch (err) {
    if (err.cymbal && (err.kind === "auth" || err.kind === "refused")) {
      markReauth(app, provider, "refresh refused: " + err.message);
      throw perr("auth", LABEL[provider] + " needs reconnecting");
    }
    throw err;
  }
  storeTokens(app, provider, tok);
  return tok.access_token;
}

const LABEL = { spotify: "Spotify", apple_music: "Apple Music", youtube: "YouTube" };

// ── Spotify ─────────────────────────────────────────────────────────────────

const spotify = {
  configured() {
    const u = util();
    return !!(u.env("SPOTIFY_CLIENT_ID") && u.env("SPOTIFY_CLIENT_SECRET"));
  },

  basic() {
    const u = util();
    if (!this.configured()) throw perr("config", "Spotify credentials are not configured");
    return "Basic " + base64(u.env("SPOTIFY_CLIENT_ID") + ":" + u.env("SPOTIFY_CLIENT_SECRET"));
  },

  redirectUri() {
    return util().publicUrl() + "/api/cymbal/oauth/spotify/callback";
  },

  authorizeUrl(state) {
    const u = util();
    return u.base("spotify_accounts") + "/authorize?" + qs({
      client_id: u.env("SPOTIFY_CLIENT_ID"),
      response_type: "code",
      redirect_uri: this.redirectUri(),
      scope: "playlist-modify-public playlist-read-private",
      state: state,
      show_dialog: "true",
    });
  },

  // Refusals from the token endpoint are 400 invalid_grant; report them as auth.
  tokenRequest(fields) {
    const u = util();
    let res;
    try {
      res = call({
        url: u.base("spotify_accounts") + "/api/token",
        method: "POST",
        headers: { "Authorization": this.basic(), "Content-Type": "application/x-www-form-urlencoded" },
        body: form(fields),
      });
    } catch (err) {
      if (err.cymbal && err.kind === "refused") throw perr("auth", err.message);
      throw err;
    }
    if (!res.json || !res.json.access_token) throw perr("refused", "token response without access_token");
    return res.json;
  },

  appToken() {
    const cached = tokenStore("cymbal_sp_app_token");
    if (cached) return cached;
    const tok = this.tokenRequest({ grant_type: "client_credentials" });
    return tokenStore("cymbal_sp_app_token", tok.access_token, Date.now() + (Number(tok.expires_in) || 3600) * 1000);
  },

  get(path, params, token) {
    const u = util();
    const res = call({
      url: u.base("spotify_api") + path + (params ? "?" + qs(params) : ""),
      headers: { "Authorization": "Bearer " + (token || this.appToken()), "Accept": "application/json" },
    });
    return res.json || {};
  },

  track(id) {
    return match().fromSpotifyTrack(this.get("/tracks/" + encodeURIComponent(id), { market: util().spotifyMarket() }));
  },

  search(q) {
    const j = this.get("/search", { q: q, type: "track", limit: "10", market: util().spotifyMarket() });
    return ((j.tracks && j.tracks.items) || []).map((t) => match().fromSpotifyTrack(t)).filter(Boolean);
  },

  me(token) {
    return this.get("/me", null, token);
  },

  createPlaylist(token, name, description) {
    const res = call({
      url: util().base("spotify_api") + "/me/playlists",
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, public: true, description: description }),
      write: true,
    });
    const j = res.json || {};
    return { id: j.id, url: (j.external_urls && j.external_urls.spotify) || ("https://open.spotify.com/playlist/" + j.id) };
  },

  // Track ids currently in the playlist. Bounded: Cymbal's playlist is small, and an
  // unbounded walk inside a cron tick is a way to stall the worker.
  playlistTrackIds(token, playlistId) {
    const ids = {};
    for (let page = 0; page < 40; page++) {
      const j = this.get("/playlists/" + encodeURIComponent(playlistId) + "/items",
        { fields: "items(track(id)),next", limit: "50", offset: String(page * 50) }, token);
      const items = j.items || [];
      items.forEach((it) => { if (it && it.track && it.track.id) ids[it.track.id] = true; });
      if (!j.next || items.length < 50) break;
    }
    return ids;
  },

  addTrack(token, playlistId, trackId) {
    call({
      url: util().base("spotify_api") + "/playlists/" + encodeURIComponent(playlistId) + "/items",
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: ["spotify:track:" + trackId] }),
      write: true,
    });
  },
};

// ── Google / YouTube ────────────────────────────────────────────────────────

const google = {
  configured() {
    const u = util();
    return !!(u.env("GOOGLE_CLIENT_ID") && u.env("GOOGLE_CLIENT_SECRET"));
  },

  redirectUri() {
    return util().publicUrl() + "/api/cymbal/oauth/youtube/callback";
  },

  authorizeUrl(state) {
    const u = util();
    return u.base("google_auth") + "/o/oauth2/v2/auth?" + qs({
      client_id: u.env("GOOGLE_CLIENT_ID"),
      redirect_uri: this.redirectUri(),
      response_type: "code",
      scope: "https://www.googleapis.com/auth/youtube",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: state,
    });
  },

  tokenRequest(fields) {
    const u = util();
    if (!this.configured()) throw perr("config", "Google credentials are not configured");
    const body = Object.assign({ client_id: u.env("GOOGLE_CLIENT_ID"), client_secret: u.env("GOOGLE_CLIENT_SECRET") }, fields);
    let res;
    try {
      res = call({
        url: u.base("google_token") + "/token",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form(body),
      });
    } catch (err) {
      if (err.cymbal && err.kind === "refused") throw perr("auth", err.message);
      throw err;
    }
    if (!res.json || !res.json.access_token) throw perr("refused", "token response without access_token");
    return res.json;
  },
};

// YouTube quota. Google resets at midnight Pacific; UTC-8 is used all year, which is
// the conservative side of daylight saving (never earlier than the real reset).
function pacificDay(ms) {
  return new Date(ms - 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function nextPacificMidnight(ms) {
  const d = new Date(ms - 8 * 3600 * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 8 * 3600 * 1000 + 60000;
}

const youtube = {
  UNITS: { list: 1, insert: 50, search: 1 },

  // Reads may use an API key; writes always use the owner's token.
  readAuth(app) {
    const key = util().env("YOUTUBE_API_KEY");
    if (key) return { key: key };
    return { token: ownerAccessToken(app, "youtube") };
  },

  // Throws quota before spending what the day no longer has.
  spend(app, kind) {
    const u = util();
    const row = connection(app, "youtube");
    const today = pacificDay(Date.now());
    if (row.getString("quota_day") !== today) {
      row.set("quota_day", today);
      row.set("quota_used", 0);
      row.set("search_used", 0);
    }
    const unitBudget = Number(u.env("CYMBAL_YOUTUBE_DAILY_UNITS", "9000")) || 9000;
    const searchBudget = Number(u.env("CYMBAL_YOUTUBE_DAILY_SEARCHES", "90")) || 90;
    const units = row.getInt("quota_used") + this.UNITS[kind];
    const searches = row.getInt("search_used") + (kind === "search" ? 1 : 0);
    if (units > unitBudget || searches > searchBudget) {
      throw perr("quota", "daily YouTube budget reached (" + kind + ")");
    }
    row.set("quota_used", units);
    row.set("search_used", searches);
    app.save(row);
  },

  get(app, path, params) {
    const u = util();
    const auth = this.readAuth(app);
    const p = Object.assign({}, params);
    const headers = { "Accept": "application/json" };
    if (auth.key) p.key = auth.key;
    else headers["Authorization"] = "Bearer " + auth.token;
    return call({ url: u.base("youtube_api") + path + "?" + qs(p), headers: headers }).json || {};
  },

  videos(app, ids) {
    if (!ids.length) return [];
    this.spend(app, "list");
    const j = this.get(app, "/videos", { part: "snippet,contentDetails,status,liveStreamingDetails", id: ids.join(","), maxResults: "50" });
    return (j.items || []).map((v) => match().fromYouTubeVideo(v)).filter(Boolean);
  },

  search(app, q) {
    this.spend(app, "search");
    const j = this.get(app, "/search", { part: "snippet", type: "video", videoCategoryId: "10", maxResults: "10", q: q });
    const ids = (j.items || []).map((it) => it && it.id && it.id.videoId).filter(Boolean);
    return this.videos(app, ids);
  },

  channelLabel(app, token) {
    const u = util();
    const j = call({
      url: u.base("youtube_api") + "/channels?" + qs({ part: "snippet", mine: "true" }),
      headers: { "Authorization": "Bearer " + token, "Accept": "application/json" },
    }).json || {};
    const it = (j.items || [])[0];
    return it && it.snippet ? String(it.snippet.title || "") : "";
  },

  createPlaylist(app, token, title, description) {
    const u = util();
    this.spend(app, "insert");
    const j = call({
      url: u.base("youtube_api") + "/playlists?" + qs({ part: "snippet,status" }),
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ snippet: { title: title, description: description }, status: { privacyStatus: "unlisted" } }),
      write: true,
    }).json || {};
    return { id: j.id, url: "https://www.youtube.com/playlist?list=" + j.id };
  },

  playlistVideoIds(app, token, playlistId) {
    const u = util();
    const ids = {};
    let pageToken = "";
    for (let page = 0; page < 40; page++) {
      this.spend(app, "list");
      const j = call({
        url: u.base("youtube_api") + "/playlistItems?" + qs({ part: "contentDetails", playlistId: playlistId, maxResults: "50", pageToken: pageToken }),
        headers: { "Authorization": "Bearer " + token, "Accept": "application/json" },
      }).json || {};
      (j.items || []).forEach((it) => { if (it && it.contentDetails && it.contentDetails.videoId) ids[it.contentDetails.videoId] = true; });
      pageToken = j.nextPageToken || "";
      if (!pageToken) break;
    }
    return ids;
  },

  addVideo(app, token, playlistId, videoId) {
    const u = util();
    this.spend(app, "insert");
    call({
      url: u.base("youtube_api") + "/playlistItems?" + qs({ part: "snippet" }),
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ snippet: { playlistId: playlistId, resourceId: { kind: "youtube#video", videoId: videoId } } }),
      write: true,
    });
  },

  nextReset: nextPacificMidnight,
};

// ── Apple Music catalogue (server-side, developer token only) ───────────────
// Library writes need the owner's Music User Token, which exists only in their
// browser; those happen in index.html, never here.

const apple = {
  configured() {
    return !!util().env("APPLE_DEVELOPER_TOKEN");
  },

  get(path, params) {
    const u = util();
    if (!this.configured()) throw perr("config", "Apple developer token is not configured");
    return call({
      url: u.base("apple_api") + path + (params ? "?" + qs(params) : ""),
      headers: { "Authorization": "Bearer " + u.env("APPLE_DEVELOPER_TOKEN"), "Accept": "application/json" },
    }).json || {};
  },

  song(id, storefront) {
    const sf = storefront || util().storefront();
    const j = this.get("/catalog/" + sf + "/songs/" + encodeURIComponent(id));
    return match().fromAppleSong((j.data || [])[0], sf);
  },

  byIsrc(isrc) {
    const sf = util().storefront();
    const j = this.get("/catalog/" + sf + "/songs", { "filter[isrc]": isrc });
    return (j.data || []).map((s) => match().fromAppleSong(s, sf)).filter(Boolean);
  },

  search(term) {
    const sf = util().storefront();
    const j = this.get("/catalog/" + sf + "/search", { types: "songs", limit: "25", term: term });
    const songs = (j.results && j.results.songs && j.results.songs.data) || [];
    return songs.map((s) => match().fromAppleSong(s, sf)).filter(Boolean);
  },
};

// The public iTunes lookup needs no credentials, so an Apple-origin post can show its
// title before Apple is configured. It has no ISRC, so it never drives an ISRC match.
const itunes = {
  lookup(id, storefront) {
    const u = util();
    const j = call({ url: u.base("itunes") + "/lookup?" + qs({ id: id, country: storefront || u.storefront(), entity: "song" }) }).json || {};
    const r = ((j.results || []).filter((x) => x && x.wrapperType === "track"))[0];
    if (!r) throw perr("not_found", "itunes lookup: no track");
    return {
      provider: "apple_music",
      id: String(r.trackId),
      title: r.trackName || "",
      artists: r.artistName ? [r.artistName] : [],
      durationMs: Number(r.trackTimeMillis) || 0,
      isrc: "",
      url: "https://music.apple.com/" + (storefront || u.storefront()) + "/song/" + r.trackId,
    };
  },
};

// ── MusicBrainz ─────────────────────────────────────────────────────────────
// One request per second per client, with a contactable User-Agent. The worker is the
// only caller and runs serially; the gap is enforced here as well, across VMs.

const musicbrainz = {
  get(path, params) {
    const u = util();
    const store = $app.store();
    const last = Number(store.get("cymbal_mb_last") || 0);
    const wait = last + 1100 - Date.now();
    if (wait > 0) sleep(Math.min(wait, 1100));
    store.set("cymbal_mb_last", Date.now());
    const contact = u.env("CYMBAL_CONTACT", u.publicUrl());
    return call({
      url: u.base("musicbrainz") + path + "?" + qs(Object.assign({ fmt: "json" }, params)),
      headers: { "User-Agent": "CymbalOnWebsite/1.0 ( " + contact + " )", "Accept": "application/json" },
      timeout: 10,
    }).json || {};
  },

  // Recording MBIDs that MusicBrainz links to this exact provider URL.
  recordingsForUrl(url) {
    let j;
    try {
      j = this.get("/url", { resource: url, inc: "recording-rels" });
    } catch (err) {
      if (err.cymbal && err.kind === "not_found") return [];
      throw err;
    }
    const out = [];
    (j.relations || []).forEach((r) => {
      if (r && r["target-type"] === "recording" && r.recording && r.recording.id && out.indexOf(r.recording.id) === -1) {
        out.push(r.recording.id);
      }
    });
    return out;
  },

  recording(mbid) {
    const j = this.get("/recording/" + encodeURIComponent(mbid), { inc: "isrcs+url-rels+artist-credits" });
    const urls = (j.relations || []).map((r) => r && r.url && r.url.resource).filter(Boolean);
    return {
      id: j.id,
      title: j.title || "",
      artists: (j["artist-credit"] || []).map((c) => c && c.name).filter(Boolean),
      durationMs: Number(j.length) || 0,
      isrcs: (j.isrcs || []).map((x) => match().isrcKey(x)).filter(Boolean),
      urls: urls,
    };
  },
};

module.exports = {
  perr: perr,
  call: call,
  connection: connection,
  storeTokens: storeTokens,
  markReauth: markReauth,
  ownerAccessToken: ownerAccessToken,
  spotify: spotify,
  google: google,
  youtube: youtube,
  apple: apple,
  itunes: itunes,
  musicbrainz: musicbrainz,
  base64: base64,
  pacificDay: pacificDay,
  nextPacificMidnight: nextPacificMidnight,
};
