/// <reference path="../pb_data/types.d.ts" />
/*
 * Accounts for everyone. Anyone can make one (email, password, a name) and sign in;
 * signed-in people get the new features (features.js "members") and can place
 * stickers. The owner is still the only account with role "admin", and still the
 * only one who can remove posts and comments or reach /api/cymbal/owner/*.
 *
 *   - sign-ups go through POST /api/cymbal/signup (lib/accounts.js), never the
 *     collection API: users.createRule stays null, and the route always makes
 *     role "user". `signups` keeps one row per sign-up so it can be rate-limited
 *     by network; like every other collection it is superuser-only.
 *   - a sign-in lasts seven days instead of thirty minutes, so members aren't asked
 *     for their password every visit.
 */
migrate((app) => {
  const signups = new Collection({
    type: "base",
    name: "signups",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: "ip_hash", type: "text", required: false, max: 64 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
    indexes: ["CREATE INDEX idx_signups_ip_created ON signups (ip_hash, created)"],
  });
  app.save(signups);

  const users = app.findCollectionByNameOrId("users");
  users.createRule = null;
  users.authToken.duration = 604800;
  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  users.authToken.duration = 1800;
  app.save(users);
  app.delete(app.findCollectionByNameOrId("signups"));
});
