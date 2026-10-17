/// <reference path="../../pb_data/types.d.ts" />
/*
 * lib/stickers.js — hearts, stars and the owner's uploaded PNGs stuck on posts.
 * Everyone sees them, and anyone can place one per post, and move or take back only
 * their own. Signed in, they are filed by account: the owner's under OWNER (as they
 * always were), everyone else's under "user:" + their account id. Signed out, they
 * are filed by browser, under the browser key's hash, the way posts and comments are.
 *
 * A sticker's kind is "heart" or "star" for the built-in two, or "u_<record id>" for
 * an upload in sticker_kinds.
 */

const KINDS = ["heart", "star"];
const BUILT_IN = [
  { id: "heart", label: "A red heart", src: "stickers/heart.png" },
  { id: "star", label: "A silver star", src: "stickers/star.png" },
];
const PER_POST = 50;
const MAX_KINDS = 48;
const PER_ACCOUNT = 3;   // stickers each account or browser can submit; the owner has no limit
const MAX_WAITING = 20;  // signed-out submissions waiting for the owner, all told
const SUBMIT_PER_NETWORK = 6;  // signed-out submissions an hour from one network
const OWNER = "owner";
const PER_NETWORK = 60;  // new stickers an hour from one network while signed out

function util() {
  return require(__hooks + "/lib/util.js");
}

function kindOf(rec) {
  const custom = rec.getString("custom");
  return custom ? "u_" + custom : rec.getString("kind");
}

// Whose stickers a request places and picks up: the account when signed in, else the
// browser key's hash ("" with no key).
function keyOf(e) {
  if (!e.auth || e.auth.collection().name !== "users") return util().writerKey(e, false);
  return util().isOwner(e) ? OWNER : "user:" + e.auth.id;
}

// `mine` is what lets the browser pick it back up.
function view(rec, viewer) {
  return {
    id: rec.id,
    kind: kindOf(rec),
    x: rec.getFloat("x"),
    y: rec.getFloat("y"),
    rot: rec.getFloat("rot"),
    mine: !!viewer && rec.getString("author_key") === viewer,
  };
}

// { postId: [sticker, ...] } for the given posts, oldest first so later ones sit on top.
function byPost(app, postIds, e) {
  const viewer = keyOf(e);
  const out = {};
  if (!postIds.length) return out;
  app.findAllRecords("stickers", $dbx.in("post", ...postIds)).forEach((r) => {
    if (!r) return;
    const p = r.getString("post");
    (out[p] = out[p] || []).push(r);
  });
  Object.keys(out).forEach((p) => {
    out[p] = out[p]
      .sort((a, b) => (a.getString("created") < b.getString("created") ? -1 : a.getString("created") > b.getString("created") ? 1 : 0))
      .map((r) => view(r, viewer));
  });
  return out;
}

function num(v, lo, hi, what) {
  const n = Number(v);
  if (typeof v !== "number" || !isFinite(n)) throw new BadRequestError("Bad " + what + ".");
  return Math.min(hi, Math.max(lo, n));
}

function place(rec, body) {
  rec.set("x", num(body.x, 0, 1, "position"));
  rec.set("y", num(body.y, 0, 5000, "position"));
  rec.set("rot", body.rot === undefined ? 0 : num(body.rot, -30, 30, "angle"));
}

function liveSticker(app, id) {
  if (!/^[a-z0-9]{15}$/.test(String(id || ""))) throw new NotFoundError("No such sticker.");
  const rec = util().findOne(app, "stickers", "id = {:id}", { id: id });
  if (!rec) throw new NotFoundError("No such sticker.");
  return rec;
}

function ownSticker(app, e, id) {
  const rec = liveSticker(app, id);
  if (rec.getString("author_key") !== keyOf(e)) throw new ForbiddenError("You can only move your own stickers.");
  return rec;
}

// POST /api/cymbal/posts/{id}/stickers  { kind, x, y, rot }
// One each per post: a second one replaces the first rather than joining it.
function add(app, e, postId, body) {
  const u = util();
  const who = keyOf(e);
  if (!who) u.writerKey(e, true); // throws: no account and no browser key
  const signedOut = !e.auth;
  if (!/^[a-z0-9]{15}$/.test(String(postId || ""))) throw new NotFoundError("No such post.");
  if (!u.findOne(app, "posts", "id = {:id} && deleted = false", { id: postId })) throw new NotFoundError("No such post.");
  const kind = String(body.kind || "");
  let custom = "";
  if (/^u_[a-z0-9]{15}$/.test(kind)) {
    custom = kind.slice(2);
    if (!u.findOne(app, "sticker_kinds", "id = {:id} && waiting = false", { id: custom })) throw new BadRequestError("Unknown sticker.");
  } else if (KINDS.indexOf(kind) === -1) {
    throw new BadRequestError("Unknown sticker.");
  }
  let rec = u.findOne(app, "stickers", "post = {:p} && author_key = {:k}", { p: postId, k: who });
  if (!rec) {
    if (app.countRecords("stickers", $dbx.hashExp({ post: postId })) >= PER_POST) {
      throw new BadRequestError("That post has " + PER_POST + " stickers already.");
    }
    const ip = signedOut ? u.ipHash(e) : "";
    u.enforceRate(app, "stickers", "ip_hash", ip, PER_NETWORK,
      "Lots of stickers from your network in the last hour. Give it a little while.");
    rec = new Record(app.findCollectionByNameOrId("stickers"));
    rec.set("post", postId);
    rec.set("author_key", who);
    rec.set("ip_hash", ip);
  }
  rec.set("kind", custom ? "" : kind);
  rec.set("custom", custom);
  place(rec, body);
  app.save(rec);
  return { sticker: view(rec, who) };
}

// POST /api/cymbal/stickers/{id}/move  { x, y, rot }
function move(app, e, id, body) {
  const rec = ownSticker(app, e, id);
  place(rec, body);
  app.save(rec);
  return { sticker: view(rec, keyOf(e)) };
}

// DELETE /api/cymbal/stickers/{id} — taking your own sticker back off.
function remove(app, e, id) {
  app.delete(ownSticker(app, e, id));
  return { ok: true };
}

function imageUrl(rec) {
  return "/api/files/sticker_kinds/" + rec.id + "/" + encodeURIComponent(rec.getString("image"));
}

// Whether a sticker sent while signed out goes live straight away. The owner switches
// it on Misc; on unless they've turned it off.
function autoApprove(app) {
  const row = util().findOne(app, "site_settings", "name = 'sticker_auto_approve'", {});
  return row ? row.getBool("on") : true;
}

// POST /api/cymbal/owner/sticker-approval  { auto: true | false }
// Turning it on leaves anything already waiting where it is, for the owner to decide.
function setAutoApprove(app, body) {
  if (typeof body.auto !== "boolean") throw new BadRequestError("Say auto: true or false.");
  let row = util().findOne(app, "site_settings", "name = 'sticker_auto_approve'", {});
  if (!row) {
    row = new Record(app.findCollectionByNameOrId("site_settings"));
    row.set("name", "sticker_auto_approve");
  }
  row.set("on", body.auto);
  app.save(row);
  return { auto: body.auto };
}

// GET /api/cymbal/sticker-kinds — every sticker there is, built-in first, so the page
// can draw any placed one. Open to everyone, like the stickers themselves.
// `auto_approve` lets the page say whether a signed-out submission will wait.
function kinds(app) {
  const uploads = app.findRecordsByFilter("sticker_kinds", "waiting = false", "created,id", MAX_KINDS, 0);
  return {
    auto_approve: autoApprove(app),
    kinds: BUILT_IN.map((k) => Object.assign({ uploaded: false }, k)).concat(uploads.map((r) => ({
      id: "u_" + r.id,
      label: r.getString("label"),
      src: imageUrl(r),
      uploaded: true,
    }))),
  };
}

// POST /api/cymbal/sticker-kinds  multipart: label, image (a PNG up to 1 MB)
// Signed in, it's live straight away. Signed out, it is too while auto approval is on;
// with it off, it waits for the owner to approve it.
function addKind(app, e) {
  const u = util();
  const owner = u.isOwner(e);
  const member = !!e.auth && e.auth.collection().name === "users";
  const key = member ? "" : u.writerKey(e, true);
  const ip = member ? "" : u.ipHash(e);
  const wait = !member && !autoApprove(app);
  const mine = member ? $dbx.hashExp({ author: e.auth.id }) : $dbx.hashExp({ author_key: key });
  if (!owner && app.countRecords("sticker_kinds", mine) >= PER_ACCOUNT) {
    throw new BadRequestError("You've submitted " + PER_ACCOUNT + " stickers already.");
  }
  if (!member) {
    u.enforceRate(app, "sticker_kinds", "ip_hash", ip, SUBMIT_PER_NETWORK,
      "Lots of stickers from your network in the last hour. Give it a little while.");
    if (wait && app.countRecords("sticker_kinds", $dbx.hashExp({ waiting: true })) >= MAX_WAITING) {
      throw new BadRequestError("There are lots of stickers waiting to be looked at already. Try again in a few days.");
    }
  }
  const body = e.requestInfo().body || {};
  const label = u.cleanText(body.label, 32, "A sticker name");
  if (label.length < 2) throw new BadRequestError("Give the sticker a name of at least 2 characters.");
  let files = [];
  try { files = e.findUploadedFiles("image") || []; } catch (_) { files = []; }
  if (files.length !== 1) throw new BadRequestError("Choose one PNG file.");
  if (app.countRecords("sticker_kinds", $dbx.hashExp({ waiting: false })) >= MAX_KINDS) throw new BadRequestError("That's " + MAX_KINDS + " stickers already. Remove one first.");
  const rec = new Record(app.findCollectionByNameOrId("sticker_kinds"));
  rec.set("label", label);
  rec.set("image", files[0]);
  rec.set("author", member ? e.auth.id : "");
  rec.set("author_key", key);
  rec.set("ip_hash", ip);
  rec.set("waiting", wait);
  try {
    app.save(rec);
  } catch (err) {
    throw new BadRequestError("That file wasn't accepted. Stickers are PNGs up to 1 MB.");
  }
  return { kind: { id: "u_" + rec.id, label: label, src: imageUrl(rec), uploaded: true, waiting: wait } };
}

// GET /api/cymbal/owner/sticker-kinds/waiting — signed-out submissions, oldest first.
function waitingKinds(app) {
  return {
    kinds: app.findRecordsByFilter("sticker_kinds", "waiting = true", "created,id", MAX_WAITING, 0).map((r) => ({
      id: "u_" + r.id, label: r.getString("label"), src: imageUrl(r), uploaded: true, waiting: true,
    })),
  };
}

// POST /api/cymbal/owner/sticker-kinds/{id}/approve — everyone can stick it from now on.
function approveKind(app, id) {
  const m = /^u_([a-z0-9]{15})$/.exec(String(id || ""));
  const rec = m ? util().findOne(app, "sticker_kinds", "id = {:id} && waiting = true", { id: m[1] }) : null;
  if (!rec) throw new NotFoundError("No such sticker waiting.");
  if (app.countRecords("sticker_kinds", $dbx.hashExp({ waiting: false })) >= MAX_KINDS) throw new BadRequestError("That's " + MAX_KINDS + " stickers already. Remove one first.");
  rec.set("waiting", false);
  app.save(rec);
  return { kind: { id: "u_" + rec.id, label: rec.getString("label"), src: imageUrl(rec), uploaded: true } };
}

// DELETE /api/cymbal/owner/sticker-kinds/{id} — and every placed sticker made from it.
function removeKind(app, id) {
  const m = /^u_([a-z0-9]{15})$/.exec(String(id || ""));
  const rec = m ? util().findOne(app, "sticker_kinds", "id = {:id}", { id: m[1] }) : null;
  if (!rec) throw new NotFoundError("No such sticker.");
  app.delete(rec);
  return { ok: true };
}

// GET /api/cymbal/owner/leaderboard — posts by how many reacts (stickers) they have,
// with listens and comments alongside to break ties.
function leaderboard(app) {
  const rows = arrayOf(new DynamicModel({ post: "", kind: "", custom: "", n: 0 }));
  app.db().newQuery(
    "SELECT post, kind, custom, COUNT(*) AS n FROM stickers GROUP BY post, kind, custom"
  ).all(rows);
  const byPost = {};
  rows.forEach((r) => {
    const k = r.custom ? "u_" + r.custom : r.kind;
    const b = byPost[r.post] = byPost[r.post] || { reacts: 0, kinds: {} };
    b.reacts += r.n;
    b.kinds[k] = (b.kinds[k] || 0) + r.n;
  });
  const ids = Object.keys(byPost);
  const posts = ids.length ? app.findAllRecords("posts", $dbx.in("id", ...ids), $dbx.hashExp({ deleted: false })) : [];
  const out = posts.filter((p) => !!p).map((p) => ({
    id: p.id,
    title: p.getString("title"),
    artist: p.getString("artist"),
    poster: p.getString("pseudonym") || "someone",
    url: p.getString("canonical_url"),
    created: p.getString("created"),
    reacts: byPost[p.id].reacts,
    kinds: byPost[p.id].kinds,
    listens: p.getInt("listen_count"),
    comments: p.getInt("comment_count"),
  }));
  out.sort((a, b) => b.reacts - a.reacts || b.listens - a.listens || b.comments - a.comments || (a.created < b.created ? 1 : -1));
  return { posts: out.slice(0, 20) };
}

module.exports = {
  byPost: byPost, add: add, move: move, remove: remove,
  kinds: kinds, addKind: addKind, removeKind: removeKind, waitingKinds: waitingKinds,
  approveKind: approveKind, leaderboard: leaderboard,
  autoApprove: autoApprove, setAutoApprove: setAutoApprove,
};
