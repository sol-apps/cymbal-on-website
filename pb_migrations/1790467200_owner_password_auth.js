/// <reference path="../pb_data/types.d.ts" />
/*
 * Cymbal stops using platform single sign-on. The owner is the only person who ever
 * signs in, so the users collection becomes a plain PocketBase password collection:
 *
 *   - password auth ON, OAuth2 OFF, and the stored OIDC provider (with its client
 *     secret) removed from the database;
 *   - no self-service accounts: createRule null, so only a superuser can create a
 *     user. The owner's account is made in the dashboard, with role = admin set there;
 *   - role stays settable by nobody but a superuser: updateRule keeps the
 *     `@request.body.role:isset = false` guard from 1756540000_identity.js.
 *
 * Friends never sign in (typed name + X-Cymbal-Key) and are untouched by this.
 * Down restores the SSO-era rules; pb_hooks/identity.pb.js, if restored with it,
 * re-applies the OIDC provider from the env on its next boot.
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  users.passwordAuth.enabled = true;
  users.oauth2.enabled = false;
  users.oauth2.providers = [];
  users.createRule = null;
  users.updateRule = "id = @request.auth.id && @request.body.role:isset = false";
  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  users.passwordAuth.enabled = false;
  users.oauth2.enabled = true;
  users.createRule = "@request.context = 'oauth2'";
  users.updateRule = "id = @request.auth.id && @request.body.role:isset = false";
  app.save(users);
});
