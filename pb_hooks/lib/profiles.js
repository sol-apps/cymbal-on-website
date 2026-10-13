/// <reference path="../../pb_data/types.d.ts" />
/*
 * lib/profiles.js — a picture for an account. Anyone signed in can set one; the posts
 * that account makes show it. Rows are keyed "user:" + the account id. Nothing returned
 * says whose a picture is: a reader only ever gets the image's URL.
 */

const PER_IP_HOUR = 20;   // new pictures from one network in an hour
const MIN_GAP_MS = 15000; // between changes from one account

function util() {
  return require(__hooks + "/lib/util.js");
}

function imageUrl(rec) {
  return "/api/files/profiles/" + rec.id + "/" + encodeURIComponent(rec.getString("image"));
}

function keyOf(e) {
  if (!e.auth || e.auth.collection().name !== "users") throw new UnauthorizedError("Sign in to set a picture.");
  return "user:" + e.auth.id;
}

function mine(app, key) {
  return util().findOne(app, "profiles", "author_key = {:k}", { k: key });
}

// GET /api/cymbal/me/profile
function get(app, e) {
  const rec = mine(app, keyOf(e));
  return { pic: rec ? imageUrl(rec) : "" };
}

// POST /api/cymbal/me/profile  multipart: image (PNG, JPEG or WebP up to 1 MB)
function set(app, e) {
  const u = util();
  const key = keyOf(e);
  let files = [];
  try { files = e.findUploadedFiles("image") || []; } catch (_) { files = []; }
  if (files.length !== 1) throw new BadRequestError("Choose one picture.");
  let rec = mine(app, key);
  if (rec && Date.now() - u.parseTime(rec.getString("updated")) < MIN_GAP_MS) {
    throw new TooManyRequestsError("Give it a few seconds before changing it again.");
  }
  if (!rec) {
    const ip = u.ipHash(e);
    u.enforceRate(app, "profiles", "ip_hash", ip, PER_IP_HOUR, "Lots of new pictures from your network. Give it a little while.");
    rec = new Record(app.findCollectionByNameOrId("profiles"));
    rec.set("author_key", key);
    rec.set("ip_hash", ip);
  }
  rec.set("image", files[0]);
  try {
    app.save(rec);
  } catch (err) {
    throw new BadRequestError("That picture wasn't accepted. Use a PNG, JPEG or WebP up to 1 MB.");
  }
  return { pic: imageUrl(rec) };
}

// DELETE /api/cymbal/me/profile
function clear(app, e) {
  const rec = mine(app, keyOf(e));
  if (rec) app.delete(rec);
  return { pic: "" };
}

// { accountId: url } for the given account ids.
function picsByAccount(app, ids) {
  const out = {};
  const wanted = ids.filter((id) => !!id).map((id) => "user:" + id);
  if (!wanted.length) return out;
  app.findAllRecords("profiles", $dbx.in("author_key", ...wanted)).forEach((r) => {
    if (r) out[r.getString("author_key").slice(5)] = imageUrl(r);
  });
  return out;
}

module.exports = { get: get, set: set, clear: clear, picsByAccount: picsByAccount };
