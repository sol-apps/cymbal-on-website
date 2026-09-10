/// <reference path="../../pb_data/types.d.ts" />
/*
 * lib/feed.js — posts, comments and the feed: everything a visitor reads or writes.
 *
 * Nobody signs in to post. A writer is a typed name plus the hash of their browser's
 * private key (util.writerKey); the key is what lets that browser remove its own
 * posts. The collections are superuser-only at the rule level, so this module is the
 * only way in, and it guarantees:
 *   - nothing returned carries a key hash, an address hash or a provider response;
 *     a reader gets the typed name and a `mine` flag computed against their own key;
 *   - every write is rate-limited per browser key and per network, deleted rows
 *     counted;
 *   - replaying a request_id from the same browser returns the original result.
 */

const PAGE = 15;
const STATE = { pending: "pending", pending_device: "pending", synced: "synced", attention: "attention", cancelled: "cancelled" };

const LIMITS = {
  posts: { key: 10, ip: 30, noun: "posts" },
  comments: { key: 60, ip: 180, noun: "comments" },
};

function util() {
  return require(__hooks + "/lib/util.js");
}

function urls() {
  return require(__hooks + "/lib/urls.js");
}

function syncsByPost(app, postIds) {
  const out = {};
  if (!postIds.length) return out;
  app.findAllRecords("playlist_syncs", $dbx.in("post", ...postIds)).forEach((r) => {
    if (!r) return;
    const p = r.getString("post");
    (out[p] = out[p] || []).push(r);
  });
  return out;
}

function syncView(rows) {
  const u = util();
  const out = {};
  u.PROVIDERS.forEach((p) => { out[p] = { state: "pending", url: "" }; });
  (rows || []).forEach((r) => {
    const status = r.getString("status");
    out[r.getString("target")] = {
      state: STATE[status] || "pending",
      url: status === "synced" ? r.getString("target_url") : "",
    };
  });
  return out;
}

function postView(rec, syncs, keyHash, owner) {
  const u = util();
  const mine = !!keyHash && rec.getString("author_key") === keyHash;
  const meta = rec.getString("meta_status");
  const source = rec.getString("source_provider");
  return {
    id: rec.id,
    title: rec.getString("title"),
    artist: rec.getString("artist"),
    duration_ms: rec.getInt("duration_ms"),
    source: source,
    source_label: u.LABELS[source] || source,
    url: rec.getString("canonical_url"),
    caption: rec.getString("caption"),
    poster: rec.getString("pseudonym") || "someone",
    mine: mine,
    can_delete: mine || owner,
    created: rec.getString("created"),
    comment_count: rec.getInt("comment_count"),
    resolving: meta === "pending",
    unavailable: meta === "failed",
    sync: syncView(syncs),
  };
}

function views(app, rows, e) {
  const u = util();
  const owner = u.isOwner(e);
  const keyHash = u.writerKey(e, false);
  const syncs = syncsByPost(app, rows.map((r) => r.id));
  return rows.map((r) => postView(r, syncs[r.id], keyHash, owner));
}

function livePost(app, id) {
  if (!/^[a-z0-9]{15}$/.test(String(id || ""))) throw new NotFoundError("No such post.");
  const post = util().findOne(app, "posts", "id = {:id} && deleted = false", { id: id });
  if (!post) throw new NotFoundError("No such post.");
  return post;
}

// Both limits in the writer's own transaction, so two quick requests cannot both
// slip under them.
function limit(tx, collection, keyHash, ip) {
  const u = util();
  const l = LIMITS[collection];
  u.enforceRate(tx, collection, "author_key", keyHash, l.key,
    "That's " + l.key + " " + l.noun + " in the last hour. Give it a little while.");
  u.enforceRate(tx, collection, "ip_hash", ip, l.ip,
    "Lots of " + l.noun + " from your network in the last hour. Give it a little while.");
}

// GET /api/cymbal/feed?cursor=<post id>
function feed(app, e) {
  const u = util();
  const cursor = String(e.request.url.query().get("cursor") || "");
  let filter = "deleted = false";
  const params = {};
  if (cursor) {
    if (!/^[a-z0-9]{15}$/.test(cursor)) throw new BadRequestError("Bad cursor.");
    const at = u.findOne(app, "posts", "id = {:id}", { id: cursor });
    if (!at) throw new BadRequestError("Bad cursor.");
    filter += " && (created < {:c} || (created = {:c} && id < {:id}))";
    params.c = at.getString("created");
    params.id = at.id;
  }
  const rows = app.findRecordsByFilter("posts", filter, "-created,-id", PAGE + 1, 0, params);
  const page = rows.slice(0, PAGE);
  return {
    posts: views(app, page, e),
    next_cursor: rows.length > PAGE ? page[page.length - 1].id : "",
  };
}

function postById(app, e, id) {
  return views(app, [app.findRecordById("posts", id)], e)[0];
}

function findReplay(app, collection, keyHash, rid) {
  return util().findOne(app, collection, "author_key = {:k} && request_id = {:r}", { k: keyHash, r: rid });
}

// POST /api/cymbal/posts {url, name, caption, request_id}
function createPost(app, e) {
  const u = util();
  const body = e.requestInfo().body || {};
  const keyHash = u.writerKey(e, true);
  const rid = u.requestId(body.request_id);

  const replay = findReplay(app, "posts", keyHash, rid);
  if (replay) return { replayed: true, post: postById(app, e, replay.id) };

  const parsed = urls().parseTrackUrl(body.url);
  if (!parsed.ok) throw new BadRequestError(parsed.message);
  const caption = u.cleanText(body.caption, 500, "A caption");
  const name = u.pseudonym(body.name);
  const ip = u.ipHash(e);

  let postId = "";
  try {
    app.runInTransaction((tx) => {
      limit(tx, "posts", keyHash, ip);
      const now = u.pbTime(Date.now());
      const post = new Record(tx.findCollectionByNameOrId("posts"));
      post.set("pseudonym", name);
      post.set("author_key", keyHash);
      post.set("ip_hash", ip);
      post.set("source_provider", parsed.provider);
      post.set("source_id", parsed.id);
      post.set("storefront", parsed.storefront || "");
      post.set("canonical_url", parsed.canonicalUrl);
      post.set("caption", caption);
      post.set("meta_status", "pending");
      post.set("meta_attempts", 0);
      post.set("meta_next_at", now);
      post.set("request_id", rid);
      post.set("comment_count", 0);
      post.set("deleted", false);
      tx.save(post);

      // Exactly three sync rows, in the same transaction as the post. The source
      // provider's row already knows its item; Apple's then waits for the owner's
      // browser, the others for the worker.
      const syncs = tx.findCollectionByNameOrId("playlist_syncs");
      u.PROVIDERS.forEach((p) => {
        const row = new Record(syncs);
        row.set("post", post.id);
        row.set("target", p);
        row.set("attempts", 0);
        row.set("next_at", now);
        if (p === parsed.provider) {
          row.set("target_id", parsed.id);
          row.set("target_url", urls().trackUrl(p, parsed.id, parsed.storefront));
          row.set("match_basis", "source");
          row.set("status", p === "apple_music" ? "pending_device" : "pending");
        } else {
          row.set("status", "pending");
        }
        tx.save(row);
      });
      postId = post.id;
    });
  } catch (err) {
    // Two copies of one request racing: the loser hits the unique index.
    const again = findReplay(app, "posts", keyHash, rid);
    if (again) return { replayed: true, post: postById(app, e, again.id) };
    throw err;
  }

  // Best effort, so the card has a title straight away. The worker retries anything
  // this misses; a slow provider only delays the response, never loses the post.
  try {
    require(__hooks + "/lib/sync.js").resolveMeta(app, postId);
  } catch (err) {
    console.log("[cymbal] immediate metadata lookup failed for " + postId + ": " + err);
  }
  return { replayed: false, post: postById(app, e, postId) };
}

// DELETE /api/cymbal/posts/{id} — the browser that wrote it, or the owner.
function deletePost(app, e, id) {
  const u = util();
  if (!/^[a-z0-9]{15}$/.test(String(id || ""))) throw new NotFoundError("No such post.");
  const post = u.findOne(app, "posts", "id = {:id}", { id: id });
  if (!post) throw new NotFoundError("No such post.");
  const keyHash = u.writerKey(e, false);
  const byAuthor = !!keyHash && post.getString("author_key") === keyHash;
  if (!byAuthor && !u.isOwner(e)) throw new ForbiddenError("You can only remove your own posts.");
  if (post.getBool("deleted")) return { ok: true };

  app.runInTransaction((tx) => {
    const p = tx.findRecordById("posts", id);
    if (p.getBool("deleted")) return;
    p.set("deleted", true);
    p.set("deleted_by", byAuthor ? "author" : "admin");
    p.set("deleted_at", u.pbTime(Date.now()));
    p.set("caption", "");
    tx.save(p);
    // Unfinished work stops. A track already added stays: playlists are
    // append-only in v1, and the Terms page says so.
    tx.findRecordsByFilter("playlist_syncs",
      "post = {:p} && status != 'synced' && status != 'cancelled'", "", 10, 0, { p: id })
      .forEach((r) => {
        r.set("status", "cancelled");
        r.set("reason", "post_deleted");
        tx.save(r);
      });
  });
  return { ok: true };
}

function commentView(rec, keyHash, owner) {
  const mine = !!keyHash && rec.getString("author_key") === keyHash;
  return {
    id: rec.id,
    body: rec.getString("body"),
    poster: rec.getString("pseudonym") || "someone",
    mine: mine,
    can_delete: mine || owner,
    created: rec.getString("created"),
  };
}

function recount(tx, postId) {
  const post = tx.findRecordById("posts", postId);
  post.set("comment_count", tx.countRecords("comments", $dbx.exp("post = {:p} AND deleted = FALSE", { p: postId })));
  tx.save(post);
}

// GET /api/cymbal/posts/{id}/comments
function listComments(app, e, postId) {
  const u = util();
  const post = livePost(app, postId);
  const rows = app.findRecordsByFilter("comments", "post = {:p} && deleted = false", "created,id", 200, 0, { p: post.id });
  const keyHash = u.writerKey(e, false);
  const owner = u.isOwner(e);
  return { comments: rows.map((r) => commentView(r, keyHash, owner)) };
}

// POST /api/cymbal/posts/{id}/comments {body, name, request_id}
function createComment(app, e, postId) {
  const u = util();
  const body = e.requestInfo().body || {};
  const keyHash = u.writerKey(e, true);
  const rid = u.requestId(body.request_id);
  const owner = u.isOwner(e);

  const replay = findReplay(app, "comments", keyHash, rid);
  if (replay) return { replayed: true, comment: commentView(replay, keyHash, owner) };

  const post = livePost(app, postId);
  const text = u.cleanText(body.body, 1000, "A comment");
  if (!text) throw new BadRequestError("A comment needs something in it.");
  const name = u.pseudonym(body.name);
  const ip = u.ipHash(e);

  let id = "";
  try {
    app.runInTransaction((tx) => {
      limit(tx, "comments", keyHash, ip);
      const c = new Record(tx.findCollectionByNameOrId("comments"));
      c.set("post", post.id);
      c.set("pseudonym", name);
      c.set("author_key", keyHash);
      c.set("ip_hash", ip);
      c.set("body", text);
      c.set("request_id", rid);
      c.set("deleted", false);
      tx.save(c);
      recount(tx, post.id);
      id = c.id;
    });
  } catch (err) {
    const again = findReplay(app, "comments", keyHash, rid);
    if (again) return { replayed: true, comment: commentView(again, keyHash, owner) };
    throw err;
  }
  return { replayed: false, comment: commentView(app.findRecordById("comments", id), keyHash, owner) };
}

// DELETE /api/cymbal/comments/{id}
function deleteComment(app, e, id) {
  const u = util();
  if (!/^[a-z0-9]{15}$/.test(String(id || ""))) throw new NotFoundError("No such comment.");
  const c = u.findOne(app, "comments", "id = {:id}", { id: id });
  if (!c) throw new NotFoundError("No such comment.");
  const keyHash = u.writerKey(e, false);
  const byAuthor = !!keyHash && c.getString("author_key") === keyHash;
  if (!byAuthor && !u.isOwner(e)) throw new ForbiddenError("You can only remove your own comments.");
  if (c.getBool("deleted")) return { ok: true };
  app.runInTransaction((tx) => {
    const r = tx.findRecordById("comments", id);
    if (r.getBool("deleted")) return;
    r.set("deleted", true);
    r.set("deleted_by", byAuthor ? "author" : "admin");
    r.set("deleted_at", u.pbTime(Date.now()));
    r.set("body", "");
    tx.save(r);
    recount(tx, r.getString("post"));
  });
  return { ok: true };
}

// GET /api/cymbal/playlists — the three public links, once they exist.
function playlists(app) {
  const u = util();
  return {
    playlists: u.PROVIDERS.map((p) => {
      const row = u.findOne(app, "provider_connections", "provider = {:p}", { p: p });
      const url = row ? row.getString("playlist_url") : "";
      return { provider: p, label: u.LABELS[p], url: url, ready: !!url };
    }),
  };
}

module.exports = {
  feed: feed,
  createPost: createPost,
  deletePost: deletePost,
  listComments: listComments,
  createComment: createComment,
  deleteComment: deleteComment,
  playlists: playlists,
};
