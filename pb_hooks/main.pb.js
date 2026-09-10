/// <reference path="../pb_data/types.d.ts" />
/*
 * main.pb.js — Cymbal's routes and its one scheduled job. THIS FILE RUNS ON THE SERVER.
 *
 * Runtime is PocketBase 0.39's embedded Goja VM: no npm, no Node APIs, no async.
 * Handlers run in isolated pooled VMs, so the logic lives in pb_hooks/lib/*.js and
 * is require()d inside each handler.
 *
 * Who reaches what:
 *   - the feed, posts, comments and playlist links are open: anyone with the link
 *     reads, and posts under a typed name. A browser's private key (X-Cymbal-Key)
 *     is what lets it remove its own posts; rate limits are per key and per network.
 *   - /api/cymbal/owner/* requires a signed-in `users` record with role "admin".
 *     Only the owner signs in, through id.solhann.net, and only for this panel;
 *     the identity layer (identity.pb.js) writes that role from the provider's
 *     claim on every login.
 *   - /api/cymbal/oauth/{provider}/callback is authenticated by a single-use state
 *     bound to the owner (lib/owner.js).
 *   - the collections themselves are superuser-only (every API rule null), so none
 *     of this data is reachable through /api/collections/*.
 */

// ── everyone ────────────────────────────────────────────────────────────────

routerAdd("GET", "/api/cymbal/feed", (e) => {
  const feed = require(__hooks + "/lib/feed.js");
  return e.json(200, feed.feed(e.app, e));
});

routerAdd("POST", "/api/cymbal/posts", (e) => {
  const feed = require(__hooks + "/lib/feed.js");
  return e.json(200, feed.createPost(e.app, e));
});

routerAdd("DELETE", "/api/cymbal/posts/{id}", (e) => {
  const feed = require(__hooks + "/lib/feed.js");
  return e.json(200, feed.deletePost(e.app, e, e.request.pathValue("id")));
});

routerAdd("GET", "/api/cymbal/posts/{id}/comments", (e) => {
  const feed = require(__hooks + "/lib/feed.js");
  return e.json(200, feed.listComments(e.app, e, e.request.pathValue("id")));
});

routerAdd("POST", "/api/cymbal/posts/{id}/comments", (e) => {
  const feed = require(__hooks + "/lib/feed.js");
  return e.json(200, feed.createComment(e.app, e, e.request.pathValue("id")));
});

routerAdd("DELETE", "/api/cymbal/comments/{id}", (e) => {
  const feed = require(__hooks + "/lib/feed.js");
  return e.json(200, feed.deleteComment(e.app, e, e.request.pathValue("id")));
});

routerAdd("GET", "/api/cymbal/playlists", (e) => {
  const feed = require(__hooks + "/lib/feed.js");
  return e.json(200, feed.playlists(e.app));
});

// ── owner ───────────────────────────────────────────────────────────────────

routerAdd("GET", "/api/cymbal/owner/status", (e) => {
  require(__hooks + "/lib/util.js").requireOwner(e);
  return e.json(200, require(__hooks + "/lib/owner.js").status(e.app));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/cymbal/owner/oauth/{provider}/start", (e) => {
  require(__hooks + "/lib/util.js").requireOwner(e);
  const owner = require(__hooks + "/lib/owner.js");
  return e.json(200, owner.oauthStart(e.app, e, e.request.pathValue("provider")));
}, $apis.requireAuth("users"));

// Unauthenticated by design: see lib/owner.js oauthCallback.
routerAdd("GET", "/api/cymbal/oauth/{provider}/callback", (e) => {
  const owner = require(__hooks + "/lib/owner.js");
  return e.redirect(302, owner.oauthCallback(e.app, e, e.request.pathValue("provider")));
});

routerAdd("POST", "/api/cymbal/owner/providers/{provider}/playlist", (e) => {
  require(__hooks + "/lib/util.js").requireOwner(e);
  const owner = require(__hooks + "/lib/owner.js");
  return e.json(200, owner.createPlaylist(e.app, owner.knownProvider(e.request.pathValue("provider"))));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/cymbal/owner/providers/{provider}/disconnect", (e) => {
  require(__hooks + "/lib/util.js").requireOwner(e);
  const owner = require(__hooks + "/lib/owner.js");
  return e.json(200, owner.disconnect(e.app, owner.knownProvider(e.request.pathValue("provider"))));
}, $apis.requireAuth("users"));

routerAdd("GET", "/api/cymbal/owner/syncs", (e) => {
  require(__hooks + "/lib/util.js").requireOwner(e);
  return e.json(200, require(__hooks + "/lib/owner.js").listSyncs(e.app, e));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/cymbal/owner/syncs/{id}/retry", (e) => {
  require(__hooks + "/lib/util.js").requireOwner(e);
  return e.json(200, require(__hooks + "/lib/owner.js").retry(e.app, e.request.pathValue("id")));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/cymbal/owner/syncs/{id}/override", (e) => {
  require(__hooks + "/lib/util.js").requireOwner(e);
  const body = e.requestInfo().body || {};
  return e.json(200, require(__hooks + "/lib/owner.js").override(e.app, e.request.pathValue("id"), body.url));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/cymbal/owner/sync/run", (e) => {
  require(__hooks + "/lib/util.js").requireOwner(e);
  return e.json(200, require(__hooks + "/lib/sync.js").tick(e.app, { budgetMs: 25000 }));
}, $apis.requireAuth("users"));

routerAdd("GET", "/api/cymbal/owner/apple/config", (e) => {
  require(__hooks + "/lib/util.js").requireOwner(e);
  return e.json(200, require(__hooks + "/lib/owner.js").appleConfig(e.app));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/cymbal/owner/apple/playlist", (e) => {
  require(__hooks + "/lib/util.js").requireOwner(e);
  return e.json(200, require(__hooks + "/lib/owner.js").applePlaylist(e.app, e.requestInfo().body || {}));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/cymbal/owner/apple/share-url", (e) => {
  require(__hooks + "/lib/util.js").requireOwner(e);
  return e.json(200, require(__hooks + "/lib/owner.js").appleShareUrl(e.app, e.requestInfo().body || {}));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/cymbal/owner/apple/claim", (e) => {
  require(__hooks + "/lib/util.js").requireOwner(e);
  const body = e.requestInfo().body || {};
  return e.json(200, require(__hooks + "/lib/sync.js").appleClaim(e.app, body.max));
}, $apis.requireAuth("users"));

routerAdd("POST", "/api/cymbal/owner/apple/complete", (e) => {
  require(__hooks + "/lib/util.js").requireOwner(e);
  const body = e.requestInfo().body || {};
  return e.json(200, require(__hooks + "/lib/sync.js").appleComplete(e.app, body.results));
}, $apis.requireAuth("users"));

// ── the worker ──────────────────────────────────────────────────────────────
// Once a minute, a bounded pass. Quiet when there is nothing to do.
cronAdd("cymbal-sync", "* * * * *", () => {
  const sync = require(__hooks + "/lib/sync.js");
  try {
    const s = sync.tick($app);
    if (s.jobs || s.metadata) console.log("[cymbal] sync " + JSON.stringify(s));
  } catch (err) {
    console.log("[cymbal] sync tick failed: " + err);
  }
});
