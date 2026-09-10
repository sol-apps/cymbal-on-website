/// <reference path="../../pb_data/types.d.ts" />
/*
 * lib/sync.js — the playlist worker.
 *
 * Every post has three playlist_syncs rows. This module moves each one to `synced`,
 * `attention` or `cancelled`, a bounded handful per minute, in post order.
 *
 *   lease       a row is claimed in a transaction (lease_token + lease_until) before
 *               any work; a result is only written back by the holder of the lease.
 *   match       fixed order: the exact source item, a unique ISRC match, a unique
 *               MusicBrainz relationship, a unique exact-metadata match. Nothing
 *               fuzzy; lib/match.js decides.
 *   dedupe      playlist_memberships has one row per (provider, playlist, item). A
 *               second post of the same song finds it and adds nothing.
 *   crash-safe  needs_verify is set BEFORE a write and cleared after. If the process
 *               dies in between, the next attempt reads the playlist instead of
 *               adding a duplicate. Same after a timeout or a 5xx on a write.
 *   back off    429 -> provider-wide cooldown for Retry-After; YouTube quota ->
 *               cooldown to the Pacific reset, jobs stay queued; 5xx -> per-row
 *               exponential backoff, then `attention`.
 *
 * Apple is the exception: its library writes need the owner's Music User Token,
 * which never leaves their browser. The worker matches Apple rows to catalogue ids
 * and parks them in `pending_device`; index.html claims and completes them.
 */

const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const TICK_BUDGET_MS = 40000;
const TICK_MAX_JOBS = 12;
const PLAYLIST_NAME = "Cymbal on Website";
const PLAYLIST_DESCRIPTION = "Songs friends posted on cymbal-on-website.solhann.net.";

function util() { return require(__hooks + "/lib/util.js"); }
function providers() { return require(__hooks + "/lib/providers.js"); }
function match() { return require(__hooks + "/lib/match.js"); }
function urls() { return require(__hooks + "/lib/urls.js"); }

function backoff(attempts) {
  return Math.min(60000 * Math.pow(2, Math.max(0, attempts - 1)), 6 * 3600 * 1000);
}

// ── source metadata ─────────────────────────────────────────────────────────

function fetchSource(app, post) {
  const P = providers();
  const provider = post.getString("source_provider");
  const id = post.getString("source_id");
  const sf = post.getString("storefront");
  if (provider === "spotify") return P.spotify.track(id);
  if (provider === "apple_music") return P.apple.configured() ? P.apple.song(id, sf) : P.itunes.lookup(id, sf);
  const vids = P.youtube.videos(app, [id]);
  if (!vids.length) throw P.perr("not_found", "video not found or not public");
  return vids[0];
}

function resolveMeta(app, postId) {
  const u = util();
  const post = app.findRecordById("posts", postId);
  if (post.getString("meta_status") !== "pending") return post;
  let src = null;
  let err = null;
  try {
    src = fetchSource(app, post);
    if (!src) throw providers().perr("not_found", "no such item");
  } catch (e) {
    err = e;
  }
  const fresh = app.findRecordById("posts", postId);
  if (fresh.getString("meta_status") !== "pending") return fresh;
  if (src) {
    fresh.set("title", String(src.title || "").slice(0, 300));
    fresh.set("artist", (src.artists || []).join(", ").slice(0, 300));
    fresh.set("duration_ms", Number(src.durationMs) || 0);
    fresh.set("isrc", src.isrc || "");
    fresh.set("meta_status", "resolved");
  } else {
    const kind = err && err.cymbal ? err.kind : "bug";
    if (kind === "not_found" || kind === "refused") {
      fresh.set("meta_status", "failed");
    } else if (kind === "config" || kind === "auth") {
      // Waiting for credentials is not a failure of this post.
      fresh.set("meta_next_at", u.pbTime(Date.now() + 10 * 60000));
    } else {
      const attempts = fresh.getInt("meta_attempts") + 1;
      fresh.set("meta_attempts", attempts);
      if (attempts >= 10) fresh.set("meta_status", "failed");
      else fresh.set("meta_next_at", u.pbTime(Date.now() + backoff(attempts)));
    }
    console.log("[cymbal] metadata for " + postId + ": " + kind + " " + String((err && err.message) || err).slice(0, 200));
  }
  app.save(fresh);
  return fresh;
}

function sourceOf(post) {
  const artist = post.getString("artist");
  return {
    provider: post.getString("source_provider"),
    id: post.getString("source_id"),
    title: post.getString("title"),
    artists: artist ? [artist] : [],
    durationMs: post.getInt("duration_ms"),
    isrc: post.getString("isrc"),
    url: post.getString("canonical_url"),
  };
}

// ── matching ────────────────────────────────────────────────────────────────

function candidatesByIsrc(app, target, isrc) {
  const P = providers();
  if (target === "spotify") return P.spotify.search("isrc:" + isrc);
  if (target === "apple_music") return P.apple.byIsrc(isrc);
  return [];
}

function searchCandidates(app, target, source) {
  const P = providers();
  const t = match().searchTerms(source);
  if (!t.title || !t.artist) return [];
  const extra = t.qualifiers.length ? " " + t.qualifiers.join(" ") : "";
  if (target === "spotify") return P.spotify.search('track:"' + t.title + '" artist:"' + t.artist + '"' + extra);
  const term = t.artist + " " + t.title + extra;
  if (target === "apple_music") return P.apple.search(term);
  return P.youtube.search(app, term);
}

// Catalogue ids a MusicBrainz recording links to directly, for one target.
function linkedIds(recording, target) {
  const out = [];
  recording.urls.forEach((raw) => {
    const parsed = urls().parseTrackUrl(raw);
    if (parsed.ok && parsed.provider === target && out.indexOf(parsed.id) === -1) out.push(parsed.id);
  });
  return out.slice(0, 5);
}

function viaMusicBrainz(app, target, source) {
  const P = providers();
  const M = match();
  const recs = P.musicbrainz.recordingsForUrl(source.url);
  if (recs.length !== 1) return { outcome: recs.length ? "ambiguous" : "no_match" };
  const rec = P.musicbrainz.recording(recs[0]);
  const src = Object.assign({}, source);
  if (!src.isrc && rec.isrcs.length === 1) src.isrc = rec.isrcs[0];

  const ids = linkedIds(rec, target);
  if (ids.length) {
    let cands = [];
    if (target === "youtube") cands = P.youtube.videos(app, ids);
    else if (target === "spotify") ids.forEach((id) => { const c = P.spotify.track(id); if (c) cands.push(c); });
    else ids.forEach((id) => { const c = P.apple.song(id); if (c) cands.push(c); });
    const r = M.decide(src, cands, { target: target });
    if (r.matched) return { outcome: "matched", result: r };
  }
  if (target !== "youtube" && rec.isrcs.length) {
    let cands = [];
    rec.isrcs.slice(0, 3).forEach((isrc) => { cands = cands.concat(candidatesByIsrc(app, target, isrc)); });
    const r = M.decide(src, cands, { target: target });
    return { outcome: r.matched ? "matched" : r.reason, result: r };
  }
  return { outcome: "no_match" };
}

// -> {basis, result, steps} on a match, or {basis:"", reason, result, steps}.
function findTarget(app, target, source) {
  const M = match();
  const steps = {};
  let last = null;

  if (source.isrc && target !== "youtube") {
    const r = M.decide(source, candidatesByIsrc(app, target, source.isrc), { target: target, isrc: source.isrc });
    steps.isrc = r.matched ? "matched" : r.reason;
    last = r;
    if (r.matched) return { basis: "isrc", result: r, steps: steps };
  }

  // MusicBrainz is a helper, not a dependency: its outage skips this step.
  try {
    const mb = viaMusicBrainz(app, target, source);
    steps.musicbrainz = mb.outcome;
    if (mb.result) last = mb.result;
    if (mb.outcome === "matched") return { basis: "musicbrainz", result: mb.result, steps: steps };
  } catch (err) {
    if (!err.cymbal) throw err;
    steps.musicbrainz = "skipped (" + err.kind + ")";
  }

  const r = M.decide(source, searchCandidates(app, target, source), { target: target });
  steps.metadata = r.matched ? "matched" : r.reason;
  if (r.matched) return { basis: "metadata", result: r, steps: steps };
  last = r;

  const ambiguous = Object.keys(steps).some((k) => steps[k] === "ambiguous");
  return { basis: "", reason: ambiguous ? "ambiguous" : "no_match", result: last, steps: steps };
}

// ── leases ──────────────────────────────────────────────────────────────────

function applyPatch(r, patch) {
  const u = util();
  Object.keys(patch).forEach((k) => {
    const v = patch[k];
    if (v === undefined) return;
    if (k === "next_at" || k === "synced_at") r.set(k, v ? u.pbTime(v) : "");
    else r.set(k, v);
  });
}

function claim(app, rowId, status) {
  const u = util();
  let token = "";
  app.runInTransaction((tx) => {
    const r = tx.findRecordById("playlist_syncs", rowId);
    if (r.getString("status") !== status) return;
    if (u.parseTime(r.getString("lease_until")) > Date.now()) return;
    token = $security.randomString(24);
    r.set("lease_token", token);
    r.set("lease_until", u.pbTime(Date.now() + LEASE_MS));
    tx.save(r);
  });
  return token;
}

// Write a patch while still holding the lease. Throws if the lease was lost.
function saveUnderLease(app, rowId, token, patch) {
  app.runInTransaction((tx) => {
    const r = tx.findRecordById("playlist_syncs", rowId);
    if (r.getString("lease_token") !== token) throw new Error("lease lost");
    applyPatch(r, patch);
    tx.save(r);
  });
}

// End the lease with a final (or next) state. A row cancelled mid-flight stays
// cancelled unless the item did in fact reach the playlist, which is then the truth.
function finish(app, rowId, token, patch) {
  let out = "lost";
  app.runInTransaction((tx) => {
    const r = tx.findRecordById("playlist_syncs", rowId);
    if (r.getString("lease_token") !== token) return;
    if (r.getString("status") === "cancelled" && patch.status !== "synced") {
      out = "cancelled";
    } else {
      applyPatch(r, patch);
      out = patch.status || r.getString("status");
    }
    r.set("lease_token", "");
    r.set("lease_until", "");
    tx.save(r);
  });
  return out;
}

function release(app, rowId, token, patch) {
  const p = Object.assign({}, patch);
  delete p.status;
  finish(app, rowId, token, p);
  return patch.reason || "released";
}

// ── provider state ──────────────────────────────────────────────────────────

function cooldown(app, provider, ms, why) {
  const u = util();
  const c = providers().connection(app, provider);
  c.set("cooldown_until", u.pbTime(Date.now() + Math.max(1000, ms)));
  c.set("last_error", String(why || "").slice(0, 400));
  app.save(c);
}

function touchOk(app, provider) {
  const u = util();
  const c = providers().connection(app, provider);
  c.set("last_ok_at", u.pbTime(Date.now()));
  c.set("last_error", "");
  app.save(c);
}

function cooling(conn) {
  return util().parseTime(conn.getString("cooldown_until")) > Date.now();
}

// Which targets the worker may take jobs for right now. A target that is not
// ready keeps its jobs queued, untouched; nothing is burnt waiting.
function readiness(app) {
  const P = providers();
  const sp = P.connection(app, "spotify");
  const yt = P.connection(app, "youtube");
  const ap = P.connection(app, "apple_music");
  return {
    spotify: P.spotify.configured() && sp.getString("status") === "connected" && !!sp.getString("playlist_id") && !cooling(sp),
    youtube: P.google.configured() && yt.getString("status") === "connected" && !!yt.getString("playlist_id") && !cooling(yt),
    apple_music: P.apple.configured() && !cooling(ap),
  };
}

function hasMembership(app, provider, playlistId, itemId) {
  return !!util().findOne(app, "playlist_memberships",
    "provider = {:p} && playlist_id = {:l} && item_id = {:i}", { p: provider, l: playlistId, i: itemId });
}

function addMembership(app, provider, playlistId, itemId, syncId) {
  if (hasMembership(app, provider, playlistId, itemId)) return;
  try {
    const m = new Record(app.findCollectionByNameOrId("playlist_memberships"));
    m.set("provider", provider);
    m.set("playlist_id", playlistId);
    m.set("item_id", itemId);
    if (syncId) m.set("sync", syncId);
    app.save(m);
  } catch (err) {
    if (!hasMembership(app, provider, playlistId, itemId)) throw err;
  }
}

// ── one job ─────────────────────────────────────────────────────────────────

const HUMAN = {
  no_match: "No confident match on this service. Paste the exact link to fix it.",
  ambiguous: "More than one recording fits equally well. Paste the exact link to pick one.",
  policy: "Matching Spotify songs to other services is switched off.",
  source_unavailable: "The original link couldn't be looked up, so there is nothing to match.",
  waiting_for_spotify: "Spotify songs are matched once they are on your Spotify playlist, and that didn't happen.",
  unavailable: "That item isn't available on this service.",
  refused: "The service refused the request.",
  gave_up: "Kept failing, so it stopped retrying. Retry when the service is healthy.",
};

function writeItem(app, rowId, token, target, itemId) {
  const P = providers();
  const conn = P.connection(app, target);
  const playlistId = conn.getString("playlist_id");
  if (!playlistId || conn.getString("status") !== "connected") {
    return release(app, rowId, token, { reason: "waiting_for_playlist", next_at: Date.now() + 10 * 60000 });
  }
  const row = app.findRecordById("playlist_syncs", rowId);

  if (hasMembership(app, target, playlistId, itemId)) {
    return finish(app, rowId, token, { status: "synced", synced_at: Date.now(), reason: "", needs_verify: false,
      detail: "Already on the playlist from an earlier post." });
  }
  const access = P.ownerAccessToken(app, target);
  if (row.getBool("needs_verify")) {
    const present = target === "spotify" ? P.spotify.playlistTrackIds(access, playlistId)
      : P.youtube.playlistVideoIds(app, access, playlistId);
    if (present[itemId]) {
      addMembership(app, target, playlistId, itemId, rowId);
      return finish(app, rowId, token, { status: "synced", synced_at: Date.now(), reason: "", needs_verify: false,
        detail: "Confirmed on the playlist after an interrupted write." });
    }
  }

  saveUnderLease(app, rowId, token, { needs_verify: true });
  if (target === "spotify") P.spotify.addTrack(access, playlistId, itemId);
  else P.youtube.addVideo(app, access, playlistId, itemId);
  addMembership(app, target, playlistId, itemId, rowId);
  touchOk(app, target);
  return finish(app, rowId, token, { status: "synced", synced_at: Date.now(), reason: "", detail: "", needs_verify: false });
}

function processRow(app, rowId, token) {
  const u = util();
  const U = urls();
  let row = app.findRecordById("playlist_syncs", rowId);
  const target = row.getString("target");
  const post = app.findRecordById("posts", row.getString("post"));
  if (post.getBool("deleted")) return finish(app, rowId, token, { status: "cancelled", reason: "post_deleted" });

  if (!row.getString("target_id")) {
    const meta = post.getString("meta_status");
    if (meta === "pending") return release(app, rowId, token, { reason: "waiting_for_source", next_at: Date.now() + 5000 });
    if (meta === "failed") return finish(app, rowId, token, { status: "attention", reason: "source_unavailable", detail: HUMAN.source_unavailable });

    // Spotify's metadata reaches another catalogue only (a) while the owner has
    // recorded that the terms allow it, and (b) once the track is on the owner's own
    // Spotify playlist, which is the exception the policy describes. Fails closed.
    if (post.getString("source_provider") === "spotify") {
      if (!u.spotifyTransferAllowed()) return finish(app, rowId, token, { status: "attention", reason: "policy", detail: HUMAN.policy });
      const sp = u.findOne(app, "playlist_syncs", "post = {:p} && target = 'spotify'", { p: post.id });
      const st = sp ? sp.getString("status") : "";
      if (st === "pending") return release(app, rowId, token, { reason: "waiting_for_spotify", next_at: Date.now() + 5000 });
      if (st !== "synced") return finish(app, rowId, token, { status: "attention", reason: "waiting_for_spotify", detail: HUMAN.waiting_for_spotify });
    }

    const found = findTarget(app, target, sourceOf(post));
    const evidence = {
      steps: found.steps,
      want: found.result ? found.result.evidence.want : null,
      picked: found.result ? found.result.evidence.picked || null : null,
      rejected: found.result ? found.result.evidence.rejected : [],
      ambiguous: found.result ? found.result.evidence.ambiguous || [] : [],
    };
    if (!found.basis) {
      return finish(app, rowId, token, { status: "attention", reason: found.reason, detail: HUMAN[found.reason], evidence: evidence });
    }
    const c = found.result.candidate;
    saveUnderLease(app, rowId, token, {
      target_id: c.id,
      target_url: c.url || U.trackUrl(target, c.id),
      match_basis: found.basis,
      evidence: evidence,
    });
    row = app.findRecordById("playlist_syncs", rowId);
  }

  if (target === "apple_music") {
    return finish(app, rowId, token, { status: "pending_device", reason: "", detail: "" });
  }
  return writeItem(app, rowId, token, target, row.getString("target_id"));
}

function handleError(app, rowId, token, err) {
  const P = providers();
  const row = app.findRecordById("playlist_syncs", rowId);
  const target = row.getString("target");
  const kind = err && err.cymbal ? err.kind : "bug";
  const msg = (kind + ": " + String((err && err.message) || err)).slice(0, 300);
  if (kind === "bug") console.log("[cymbal] sync " + rowId + " failed: " + msg);

  if (kind === "config") return release(app, rowId, token, { reason: "not_configured", detail: msg, next_at: Date.now() + 10 * 60000 });
  if (kind === "auth") return release(app, rowId, token, { reason: "reconnect", detail: msg, next_at: Date.now() + 10 * 60000 });
  if (kind === "rate") {
    cooldown(app, target, err.retryAfterMs || 60000, msg);
    return release(app, rowId, token, { reason: "rate_limited", detail: msg });
  }
  if (kind === "quota") {
    cooldown(app, target, P.nextPacificMidnight(Date.now()) - Date.now(), msg);
    return release(app, rowId, token, { reason: "quota", detail: msg });
  }
  if (kind === "not_found") return finish(app, rowId, token, { status: "attention", reason: "unavailable", detail: HUMAN.unavailable + " (" + msg + ")" });
  if (kind === "refused") return finish(app, rowId, token, { status: "attention", reason: "refused", detail: HUMAN.refused + " (" + msg + ")" });

  const attempts = row.getInt("attempts") + 1;
  if (attempts >= MAX_ATTEMPTS) {
    return finish(app, rowId, token, { status: "attention", reason: "gave_up", detail: HUMAN.gave_up + " (" + msg + ")", attempts: attempts });
  }
  return release(app, rowId, token, {
    attempts: attempts,
    next_at: Date.now() + Math.max(backoff(attempts), err.retryAfterMs || 0),
    reason: kind === "uncertain" ? "verifying" : "retrying",
    detail: msg,
    needs_verify: kind === "uncertain" ? true : undefined,
  });
}

function runJob(app, rowId) {
  const token = claim(app, rowId, "pending");
  if (!token) return "busy";
  try {
    return processRow(app, rowId, token);
  } catch (err) {
    try {
      return handleError(app, rowId, token, err);
    } catch (inner) {
      console.log("[cymbal] could not record failure for " + rowId + ": " + inner);
      return "error";
    }
  }
}

// One bounded pass: metadata first, then due jobs for ready targets, in post order.
// A process-wide flag keeps the cron tick and "sync now" from running at once, which
// is what makes the membership check-then-add safe for two posts of one song.
function tick(app, opts) {
  const u = util();
  const o = opts || {};
  const store = $app.store();
  if (Number(store.get("cymbal_tick_until") || 0) > Date.now()) return { skipped: "a sync run is already in progress" };
  const budget = o.budgetMs || TICK_BUDGET_MS;
  const started = Date.now();
  store.set("cymbal_tick_until", started + budget + 30000);
  const summary = { metadata: 0, jobs: 0, outcomes: {} };
  try {
    const now = u.pbTime(Date.now());
    app.findRecordsByFilter("posts",
      "meta_status = 'pending' && deleted = false && (meta_next_at = '' || meta_next_at <= {:now})",
      "created,id", 5, 0, { now: now }).forEach((p) => {
      if (Date.now() - started > budget) return;
      try { resolveMeta(app, p.id); summary.metadata++; } catch (err) { console.log("[cymbal] metadata " + p.id + ": " + err); }
    });

    const ready = readiness(app);
    const allowed = u.PROVIDERS.filter((p) => ready[p]);
    if (allowed.length) {
      const targets = "(" + allowed.map((p) => "target = '" + p + "'").join(" || ") + ")";
      const due = app.findRecordsByFilter("playlist_syncs",
        "status = 'pending' && " + targets + " && (next_at = '' || next_at <= {:now}) && (lease_until = '' || lease_until < {:now})",
        "created,-match_basis,id", o.max || TICK_MAX_JOBS, 0, { now: u.pbTime(Date.now()) });
      for (let i = 0; i < due.length; i++) {
        if (Date.now() - started > budget) break;
        if (!readiness(app)[due[i].getString("target")]) continue; // entered cooldown this tick
        const out = runJob(app, due[i].id);
        summary.jobs++;
        summary.outcomes[out] = (summary.outcomes[out] || 0) + 1;
      }
    }
  } finally {
    store.set("cymbal_tick_until", 0);
  }
  return summary;
}

// ── Apple: the owner's browser does the writes ──────────────────────────────

function appleClaim(app, max) {
  const u = util();
  const conn = providers().connection(app, "apple_music");
  const playlistId = conn.getString("playlist_id");
  if (!playlistId) throw new BadRequestError("Create the Apple Music playlist first.");
  const rows = app.findRecordsByFilter("playlist_syncs",
    "status = 'pending_device' && target = 'apple_music' && (lease_until = '' || lease_until < {:now})",
    "created,id", Math.min(Number(max) || 25, 50), 0, { now: u.pbTime(Date.now()) });
  const items = [];
  rows.forEach((r) => {
    const token = claim(app, r.id, "pending_device");
    if (!token) return;
    const post = app.findRecordById("posts", r.getString("post"));
    const itemId = r.getString("target_id");
    if (post.getBool("deleted")) {
      finish(app, r.id, token, { status: "cancelled", reason: "post_deleted" });
      return;
    }
    if (hasMembership(app, "apple_music", playlistId, itemId)) {
      finish(app, r.id, token, { status: "synced", synced_at: Date.now(), reason: "", detail: "Already on the playlist from an earlier post." });
      return;
    }
    items.push({ sync_id: r.id, lease: token, catalog_id: itemId, title: post.getString("title"), artist: post.getString("artist") });
  });
  return { playlist_id: playlistId, items: items };
}

function appleComplete(app, results) {
  const u = util();
  const conn = providers().connection(app, "apple_music");
  const playlistId = conn.getString("playlist_id");
  let completed = 0;
  (Array.isArray(results) ? results : []).slice(0, 50).forEach((res) => {
    if (!res || typeof res.sync_id !== "string" || typeof res.lease !== "string" || !/^[a-z0-9]{15}$/.test(res.sync_id)) return;
    const r = u.findOne(app, "playlist_syncs", "id = {:id} && target = 'apple_music'", { id: res.sync_id });
    if (!r || !res.lease || r.getString("lease_token") !== res.lease) return;
    if (res.outcome === "added" || res.outcome === "present") {
      addMembership(app, "apple_music", playlistId, r.getString("target_id"), r.id);
      finish(app, r.id, res.lease, { status: "synced", synced_at: Date.now(), reason: "",
        detail: res.outcome === "present" ? "Already in the playlist." : "" });
      completed++;
      return;
    }
    const attempts = r.getInt("attempts") + 1;
    const detail = "Apple Music: " + u.cleanText(String(res.error || "unknown error").slice(0, 200), 200, "error");
    if (attempts >= MAX_ATTEMPTS) finish(app, r.id, res.lease, { status: "attention", reason: "refused", detail: detail, attempts: attempts });
    else finish(app, r.id, res.lease, { status: "pending_device", reason: "retrying", detail: detail, attempts: attempts });
  });
  if (completed) touchOk(app, "apple_music");
  return { completed: completed };
}

module.exports = {
  PLAYLIST_NAME: PLAYLIST_NAME,
  PLAYLIST_DESCRIPTION: PLAYLIST_DESCRIPTION,
  resolveMeta: resolveMeta,
  findTarget: findTarget,
  tick: tick,
  runJob: runJob,
  readiness: readiness,
  appleClaim: appleClaim,
  appleComplete: appleComplete,
};
