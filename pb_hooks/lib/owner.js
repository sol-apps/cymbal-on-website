/// <reference path="../../pb_data/types.d.ts" />
/*
 * lib/owner.js — the owner's panel: provider connections, queue health, repairs.
 *
 * Every export is reached only through a route that has already called
 * util.requireOwner(e), which reads users.role — set server-side from the identity
 * provider's claim on each login, never by a request. The OAuth callback is the one
 * exception: a redirect back from Spotify or Google carries no PocketBase token, so
 * it is authenticated by its `state` instead — random, stored only as a hash,
 * single-use, ten minutes, and bound to an owner who must STILL be the owner.
 */

const OAUTH = ["spotify", "youtube"];
const STATE_TTL_MS = 10 * 60 * 1000;
const STATUSES = ["pending", "pending_device", "synced", "attention", "cancelled"];

function util() { return require(__hooks + "/lib/util.js"); }
function providers() { return require(__hooks + "/lib/providers.js"); }
function sync() { return require(__hooks + "/lib/sync.js"); }
function urls() { return require(__hooks + "/lib/urls.js"); }

const KIND = {
  config: "isn't configured on the server yet",
  auth: "needs reconnecting",
  rate: "is rate-limiting requests right now",
  quota: "has used today's quota",
  transient: "didn't respond properly",
  uncertain: "didn't confirm the change",
  not_found: "couldn't find that",
  refused: "refused the request",
};

// Provider failures become a 400 with a short owner-facing message.
function wrap(label, fn) {
  try {
    return fn();
  } catch (err) {
    if (err && err.cymbal) throw new BadRequestError(label + " " + (KIND[err.kind] || "failed") + " (" + String(err.message).slice(0, 160) + ").");
    throw err;
  }
}

function knownProvider(p) {
  if (util().PROVIDERS.indexOf(p) === -1) throw new NotFoundError("Unknown provider.");
  return p;
}

// GET /api/cymbal/owner/status
function status(app) {
  const u = util();
  const P = providers();
  const ready = sync().readiness(app);
  const configured = { spotify: P.spotify.configured(), youtube: P.google.configured(), apple_music: P.apple.configured() };
  return {
    providers: u.PROVIDERS.map((p) => {
      const c = P.connection(app, p);
      const counts = {};
      STATUSES.forEach((s) => {
        counts[s] = app.countRecords("playlist_syncs", $dbx.exp("target = {:t} AND status = {:s}", { t: p, s: s }));
      });
      const cool = u.parseTime(c.getString("cooldown_until")) > Date.now();
      const out = {
        provider: p,
        label: u.LABELS[p],
        configured: configured[p],
        status: c.getString("status"),
        account: c.getString("account_label"),
        has_playlist: !!c.getString("playlist_id"),
        playlist_url: c.getString("playlist_url"),
        cooldown_until: cool ? c.getString("cooldown_until") : "",
        last_error: c.getString("last_error"),
        last_ok_at: c.getString("last_ok_at"),
        ready: !!ready[p],
        counts: counts,
      };
      if (p === "youtube") {
        const today = P.pacificDay(Date.now()) === c.getString("quota_day");
        out.quota = {
          units: today ? c.getInt("quota_used") : 0,
          unit_budget: Number(u.env("CYMBAL_YOUTUBE_DAILY_UNITS", "9000")) || 9000,
          searches: today ? c.getInt("search_used") : 0,
          search_budget: Number(u.env("CYMBAL_YOUTUBE_DAILY_SEARCHES", "90")) || 90,
        };
      }
      return out;
    }),
    spotify_transfer_allowed: u.spotifyTransferAllowed(),
    storefront: u.storefront(),
    redirect_uris: { spotify: P.spotify.redirectUri(), youtube: P.google.redirectUri() },
  };
}

// POST /api/cymbal/owner/oauth/{provider}/start -> {url}
function oauthStart(app, e, provider) {
  const u = util();
  const P = providers();
  if (OAUTH.indexOf(provider) === -1) throw new NotFoundError("Unknown provider.");
  const configured = provider === "spotify" ? P.spotify.configured() : P.google.configured();
  if (!configured) throw new BadRequestError(u.LABELS[provider] + " credentials aren't configured on the server yet.");

  // Housekeeping: expired states are worthless; don't let them accumulate.
  app.findRecordsByFilter("oauth_states", "expires_at < {:now}", "", 50, 0, { now: u.pbTime(Date.now()) })
    .forEach((r) => { try { app.delete(r); } catch (_) { /* raced */ } });

  const state = $security.randomString(40);
  const rec = new Record(app.findCollectionByNameOrId("oauth_states"));
  rec.set("state_hash", $security.sha256(state));
  rec.set("provider", provider);
  rec.set("owner", e.auth.id);
  rec.set("expires_at", u.pbTime(Date.now() + STATE_TTL_MS));
  rec.set("used", false);
  app.save(rec);
  return { url: provider === "spotify" ? P.spotify.authorizeUrl(state) : P.google.authorizeUrl(state) };
}

// GET /api/cymbal/oauth/{provider}/callback -> where to send the browser. Always our
// own origin; the outcome travels as a fixed word, never as provider text.
function oauthCallback(app, e, provider) {
  const u = util();
  const P = providers();
  const home = u.publicUrl() + "/";
  const q = e.request.url.query();
  const state = String(q.get("state") || "");
  const code = String(q.get("code") || "");
  if (OAUTH.indexOf(provider) === -1 || !/^[A-Za-z0-9]{40}$/.test(state)) return home + "?connect=failed";

  let row = null;
  app.runInTransaction((tx) => {
    const r = u.findOne(tx, "oauth_states", "state_hash = {:h}", { h: $security.sha256(state) });
    if (!r || r.getBool("used") || r.getString("provider") !== provider) return;
    if (u.parseTime(r.getString("expires_at")) < Date.now()) return;
    r.set("used", true);
    tx.save(r);
    row = r;
  });
  if (!row) return home + "?connect=expired";

  const owner = u.findOne(app, "users", "id = {:id}", { id: row.getString("owner") });
  if (!owner || owner.getString("role") !== "admin") return home + "?connect=failed";
  if (q.get("error") || !code) return home + "?connect=denied";

  try {
    if (provider === "spotify") {
      const tok = P.spotify.tokenRequest({ grant_type: "authorization_code", code: code, redirect_uri: P.spotify.redirectUri() });
      const me = P.spotify.me(tok.access_token);
      P.storeTokens(app, "spotify", tok, {
        account_label: String(me.display_name || me.id || "Spotify account").slice(0, 200),
        cooldown_until: "",
      });
    } else {
      const tok = P.google.tokenRequest({ grant_type: "authorization_code", code: code, redirect_uri: P.google.redirectUri() });
      const label = P.youtube.channelLabel(app, tok.access_token);
      P.storeTokens(app, "youtube", tok, {
        account_label: String(label || "YouTube account").slice(0, 200),
        cooldown_until: "",
      });
    }
  } catch (err) {
    console.log("[cymbal] oauth " + provider + " exchange failed: " + (err.kind || "") + " " + String(err.message || err).slice(0, 200));
    return home + "?connect=failed";
  }
  return home + "?connected=" + provider;
}

// POST /api/cymbal/owner/providers/{provider}/playlist — Spotify and YouTube only;
// Apple's is created in the owner's browser. Idempotent.
function createPlaylist(app, provider) {
  const u = util();
  const P = providers();
  const S = sync();
  if (OAUTH.indexOf(provider) === -1) throw new BadRequestError("Create the Apple Music playlist from the Apple section, in an authorised browser.");
  const existing = P.connection(app, provider);
  if (existing.getString("playlist_id")) return { playlist_url: existing.getString("playlist_url"), created: false };
  const pl = wrap(u.LABELS[provider], () => {
    const token = P.ownerAccessToken(app, provider);
    return provider === "spotify"
      ? P.spotify.createPlaylist(token, S.PLAYLIST_NAME, S.PLAYLIST_DESCRIPTION)
      : P.youtube.createPlaylist(app, token, S.PLAYLIST_NAME, S.PLAYLIST_DESCRIPTION);
  });
  if (!pl || !pl.id) throw new BadRequestError(u.LABELS[provider] + " didn't return a playlist id.");
  const c = P.connection(app, provider);
  c.set("playlist_id", pl.id);
  c.set("playlist_url", pl.url);
  app.save(c);
  return { playlist_url: pl.url, created: true };
}

// POST /api/cymbal/owner/providers/{provider}/disconnect — forgets the tokens and
// keeps the playlist, so reconnecting carries on where it left off.
function disconnect(app, provider) {
  const P = providers();
  if (OAUTH.indexOf(provider) === -1) throw new BadRequestError("Apple Music is authorised per browser; sign out of it there.");
  const c = P.connection(app, provider);
  c.set("status", "disconnected");
  c.set("access_token_enc", "");
  c.set("refresh_token_enc", "");
  c.set("token_expires_at", "");
  c.set("account_label", "");
  app.save(c);
  return { ok: true };
}

// GET /api/cymbal/owner/syncs?status=attention — the detail friends never see.
function listSyncs(app, e) {
  const u = util();
  const st = String(e.request.url.query().get("status") || "attention");
  if (["attention", "pending", "pending_device"].indexOf(st) === -1) throw new BadRequestError("Unknown status.");
  const rows = app.findRecordsByFilter("playlist_syncs", "status = {:s}", "-updated", 50, 0, { s: st });
  const posts = {};
  const ids = rows.map((r) => r.getString("post")).filter((id, i, a) => a.indexOf(id) === i);
  if (ids.length) app.findRecordsByIds("posts", ids).forEach((p) => { if (p) posts[p.id] = p; });
  return {
    syncs: rows.map((r) => {
      const p = posts[r.getString("post")];
      let ev = {};
      try { ev = JSON.parse(r.getString("evidence") || "{}") || {}; } catch (_) { ev = {}; }
      return {
        id: r.id,
        target: r.getString("target"),
        target_label: u.LABELS[r.getString("target")],
        status: r.getString("status"),
        reason: r.getString("reason"),
        detail: r.getString("detail"),
        attempts: r.getInt("attempts"),
        match_basis: r.getString("match_basis"),
        next_at: r.getString("next_at"),
        updated: r.getString("updated"),
        steps: ev.steps || {},
        ambiguous: (ev.ambiguous || []).slice(0, 5),
        post: p ? {
          id: p.id,
          title: p.getString("title"),
          artist: p.getString("artist"),
          url: p.getString("canonical_url"),
          source: p.getString("source_provider"),
        } : null,
      };
    }),
  };
}

function leased(r) {
  return util().parseTime(r.getString("lease_until")) > Date.now();
}

// POST /api/cymbal/owner/syncs/{id}/retry — run matching (or the write) again.
function retry(app, id) {
  if (!/^[a-z0-9]{15}$/.test(String(id || ""))) throw new NotFoundError("No such sync.");
  let out = null;
  app.runInTransaction((tx) => {
    const r = util().findOne(tx, "playlist_syncs", "id = {:id}", { id: id });
    if (!r) throw new NotFoundError("No such sync.");
    const st = r.getString("status");
    if (st === "synced") throw new BadRequestError("That's already on the playlist.");
    if (st === "cancelled") throw new BadRequestError("That post was removed.");
    if (leased(r)) throw new BadRequestError("That one is being worked on right now.");
    const basis = r.getString("match_basis");
    const keep = basis === "source" || basis === "manual";
    if (!keep) {
      r.set("target_id", "");
      r.set("target_url", "");
      r.set("match_basis", "");
    }
    const apple = r.getString("target") === "apple_music";
    r.set("status", apple && keep && r.getString("target_id") ? "pending_device" : "pending");
    r.set("attempts", 0);
    r.set("next_at", util().pbTime(Date.now()));
    r.set("reason", "");
    r.set("detail", "");
    tx.save(r);
    out = { ok: true, status: r.getString("status") };
  });
  return out;
}

// POST /api/cymbal/owner/syncs/{id}/override {url} — the owner names the exact item.
function override(app, id, rawUrl) {
  const u = util();
  if (!/^[a-z0-9]{15}$/.test(String(id || ""))) throw new NotFoundError("No such sync.");
  const parsed = urls().parseTrackUrl(rawUrl);
  if (!parsed.ok) throw new BadRequestError(parsed.message);
  let out = null;
  app.runInTransaction((tx) => {
    const r = u.findOne(tx, "playlist_syncs", "id = {:id}", { id: id });
    if (!r) throw new NotFoundError("No such sync.");
    const target = r.getString("target");
    if (parsed.provider !== target) {
      throw new BadRequestError("That's " + u.LABELS[parsed.provider] + " link; this one needs " + u.LABELS[target] + ".");
    }
    const st = r.getString("status");
    if (st === "synced") throw new BadRequestError("That's already on the playlist, and playlists are append-only.");
    if (st === "cancelled") throw new BadRequestError("That post was removed.");
    if (leased(r)) throw new BadRequestError("That one is being worked on right now. Try again in a minute.");
    r.set("target_id", parsed.id);
    r.set("target_url", urls().trackUrl(target, parsed.id, parsed.storefront));
    r.set("match_basis", "manual");
    r.set("status", target === "apple_music" ? "pending_device" : "pending");
    r.set("attempts", 0);
    r.set("next_at", u.pbTime(Date.now()));
    r.set("needs_verify", false);
    r.set("reason", "");
    r.set("detail", "Exact link supplied by the owner.");
    r.set("evidence", { manual: true, url: parsed.canonicalUrl });
    tx.save(r);
    out = { ok: true, status: r.getString("status") };
  });
  return out;
}

// ── Apple: configuration for the owner's browser, and its playlist ──────────

// The developer token is designed to be handed to a browser running MusicKit; it
// still goes only to the owner, since no one else ever runs MusicKit here.
function appleConfig(app) {
  const u = util();
  const c = providers().connection(app, "apple_music");
  return {
    configured: providers().apple.configured(),
    developer_token: u.env("APPLE_DEVELOPER_TOKEN"),
    storefront: u.storefront(),
    playlist_id: c.getString("playlist_id"),
    playlist_url: c.getString("playlist_url"),
  };
}

function applePlaylist(app, body) {
  const id = String((body && body.library_id) || "");
  if (!/^p\.[A-Za-z0-9]{1,64}$/.test(id)) throw new BadRequestError("That isn't an Apple Music library playlist id.");
  const c = providers().connection(app, "apple_music");
  const current = c.getString("playlist_id");
  if (current && current !== id) throw new BadRequestError("An Apple Music playlist is already set up.");
  c.set("playlist_id", id);
  c.set("status", "connected");
  c.set("account_label", "Authorised in the owner's browser");
  app.save(c);
  return { ok: true };
}

function appleShareUrl(app, body) {
  const parsed = urls().parseApplePlaylistUrl(body && body.url);
  if (!parsed.ok) throw new BadRequestError(parsed.message);
  const c = providers().connection(app, "apple_music");
  c.set("playlist_url", parsed.canonicalUrl);
  app.save(c);
  return { ok: true, playlist_url: parsed.canonicalUrl };
}

module.exports = {
  knownProvider: knownProvider,
  status: status,
  oauthStart: oauthStart,
  oauthCallback: oauthCallback,
  createPlaylist: createPlaylist,
  disconnect: disconnect,
  listSyncs: listSyncs,
  retry: retry,
  override: override,
  appleConfig: appleConfig,
  applePlaylist: applePlaylist,
  appleShareUrl: appleShareUrl,
};
