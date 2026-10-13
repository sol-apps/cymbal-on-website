/// <reference path="../../pb_data/types.d.ts" />
/*
 * lib/accounts.js — anyone can make an account. The collection API stays closed
 * (users.createRule null); this is the only way in, and it never makes an owner:
 * role is always "user", and only a superuser can change it.
 */

const PER_NETWORK_PER_HOUR = 5;

function util() {
  return require(__hooks + "/lib/util.js");
}

// POST /api/cymbal/signup  { email, password, name } — signs the new account in.
function signup(app, e) {
  const u = util();
  const body = e.requestInfo().body || {};
  const email = String(body.email || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestError("Enter a real email address.");
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8) throw new BadRequestError("Use a password of at least 8 characters.");
  if (password.length > 72) throw new BadRequestError("Use a password of at most 72 characters.");
  const name = u.pseudonym(body.name);
  const ip = u.ipHash(e);

  u.enforceRate(app, "signups", "ip_hash", ip, PER_NETWORK_PER_HOUR, "Too many new accounts from here. Try again in an hour.");
  if (u.findOne(app, "users", "email = {:e}", { e: email })) throw new BadRequestError("There's already an account with that email. Sign in instead.");

  const rec = new Record(app.findCollectionByNameOrId("users"));
  rec.setEmail(email);
  rec.setPassword(password);
  rec.set("name", name);
  rec.set("role", "user");
  app.runInTransaction((tx) => {
    const s = new Record(tx.findCollectionByNameOrId("signups"));
    s.set("ip_hash", ip);
    tx.save(s);
    tx.save(rec);
  });
  return rec;
}

module.exports = { signup: signup };
