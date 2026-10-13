/// <reference path="../../pb_data/types.d.ts" />
/*
 * lib/stickers.js — hearts, stars and the owner's uploaded PNGs stuck on posts.
 * Everyone sees them. Each person gets one per post; for now only the owner can place,
 * move or remove one, and theirs are filed under OWNER whichever browser they used.
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
const MAX_KINDS = 24;
const OWNER = "owner";

function util() {
  return require(__hooks + "/lib/util.js");
}

function kindOf(rec) {
  const custom = rec.getString("custom");
  return custom ? "u_" + custom : rec.getString("kind");
}

// `mine` is what lets the browser pick it back up.
function view(rec, owner) {
  return {
    id: rec.id,
    kind: kindOf(rec),
    x: rec.getFloat("x"),
    y: rec.getFloat("y"),
    rot: rec.getFloat("rot"),
    mine: !!owner && rec.getString("author_key") === OWNER,
  };
}

// { postId: [sticker, ...] } for the given posts, oldest first so later ones sit on top.
function byPost(app, postIds, owner) {
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
      .map((r) => view(r, owner));
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

// POST /api/cymbal/owner/posts/{id}/stickers  { kind, x, y, rot }
// One each per post: a second one replaces the first rather than joining it.
function add(app, postId, body) {
  const u = util();
  if (!/^[a-z0-9]{15}$/.test(String(postId || ""))) throw new NotFoundError("No such post.");
  if (!u.findOne(app, "posts", "id = {:id} && deleted = false", { id: postId })) throw new NotFoundError("No such post.");
  const kind = String(body.kind || "");
  let custom = "";
  if (/^u_[a-z0-9]{15}$/.test(kind)) {
    custom = kind.slice(2);
    if (!u.findOne(app, "sticker_kinds", "id = {:id}", { id: custom })) throw new BadRequestError("Unknown sticker.");
  } else if (KINDS.indexOf(kind) === -1) {
    throw new BadRequestError("Unknown sticker.");
  }
  let rec = u.findOne(app, "stickers", "post = {:p} && author_key = {:k}", { p: postId, k: OWNER });
  if (!rec) {
    if (app.countRecords("stickers", $dbx.hashExp({ post: postId })) >= PER_POST) {
      throw new BadRequestError("That post has " + PER_POST + " stickers already.");
    }
    rec = new Record(app.findCollectionByNameOrId("stickers"));
    rec.set("post", postId);
    rec.set("author_key", OWNER);
  }
  rec.set("kind", custom ? "" : kind);
  rec.set("custom", custom);
  place(rec, body);
  app.save(rec);
  return { sticker: view(rec, true) };
}

// POST /api/cymbal/owner/stickers/{id}/move  { x, y, rot }
function move(app, id, body) {
  const rec = liveSticker(app, id);
  place(rec, body);
  app.save(rec);
  return { sticker: view(rec, true) };
}

// DELETE /api/cymbal/owner/stickers/{id}
function remove(app, id) {
  app.delete(liveSticker(app, id));
  return { ok: true };
}

function imageUrl(rec) {
  return "/api/files/sticker_kinds/" + rec.id + "/" + encodeURIComponent(rec.getString("image"));
}

// GET /api/cymbal/sticker-kinds — every sticker there is, built-in first, so the page
// can draw any placed one. Open to everyone, like the stickers themselves.
function kinds(app) {
  const uploads = app.findRecordsByFilter("sticker_kinds", "id != ''", "created,id", MAX_KINDS, 0);
  return {
    kinds: BUILT_IN.map((k) => Object.assign({ uploaded: false }, k)).concat(uploads.map((r) => ({
      id: "u_" + r.id,
      label: r.getString("label"),
      src: imageUrl(r),
      uploaded: true,
    }))),
  };
}

// POST /api/cymbal/owner/sticker-kinds  multipart: label, image (a PNG up to 1 MB)
function addKind(app, e) {
  const u = util();
  const body = e.requestInfo().body || {};
  const label = u.cleanText(body.label, 32, "A sticker name");
  if (label.length < 2) throw new BadRequestError("Give the sticker a name of at least 2 characters.");
  let files = [];
  try { files = e.findUploadedFiles("image") || []; } catch (_) { files = []; }
  if (files.length !== 1) throw new BadRequestError("Choose one PNG file.");
  if (app.countRecords("sticker_kinds") >= MAX_KINDS) throw new BadRequestError("That's " + MAX_KINDS + " stickers already. Remove one first.");
  const rec = new Record(app.findCollectionByNameOrId("sticker_kinds"));
  rec.set("label", label);
  rec.set("image", files[0]);
  try {
    app.save(rec);
  } catch (err) {
    throw new BadRequestError("That file wasn't accepted. Stickers are PNGs up to 1 MB.");
  }
  return { kind: { id: "u_" + rec.id, label: label, src: imageUrl(rec), uploaded: true } };
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
  kinds: kinds, addKind: addKind, removeKind: removeKind, leaderboard: leaderboard,
};
