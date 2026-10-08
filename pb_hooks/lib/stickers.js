/// <reference path="../../pb_data/types.d.ts" />
/*
 * lib/stickers.js — hearts and stars stuck on posts. Everyone sees them. Each person
 * gets one per post; for now only the owner can place, move or remove one, and theirs
 * are filed under OWNER whichever browser they used.
 */

const KINDS = ["heart", "star"];
const PER_POST = 50;
const OWNER = "owner";

function util() {
  return require(__hooks + "/lib/util.js");
}

// `mine` is what lets the browser pick it back up.
function view(rec, owner) {
  return {
    id: rec.id,
    kind: rec.getString("kind"),
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
  if (KINDS.indexOf(body.kind) === -1) throw new BadRequestError("Unknown sticker.");
  let rec = u.findOne(app, "stickers", "post = {:p} && author_key = {:k}", { p: postId, k: OWNER });
  if (!rec) {
    if (app.countRecords("stickers", $dbx.hashExp({ post: postId })) >= PER_POST) {
      throw new BadRequestError("That post has " + PER_POST + " stickers already.");
    }
    rec = new Record(app.findCollectionByNameOrId("stickers"));
    rec.set("post", postId);
    rec.set("author_key", OWNER);
  }
  rec.set("kind", body.kind);
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

module.exports = { byPost: byPost, add: add, move: move, remove: remove };
