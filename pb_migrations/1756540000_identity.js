/// <reference path="../pb_data/types.d.ts" />
/*
 * The `users` collection as Cymbal first had it, when the owner signed in through an
 * identity provider. 1790467200_owner_password_auth.js later replaced that with a
 * password and closed account creation. This file stays because it is where the `role`
 * field comes from: the owner is the user whose role is `admin`, set in the dashboard.
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");

  // Which role this person holds. Only a superuser can set it (see updateRule).
  if (!users.fields.getByName("role")) {
    users.fields.add(new SelectField({
      name: "role",
      values: ["user", "admin"],
      maxSelect: 1,
      required: false,
    }));
  }

  // Superseded by 1790467200, which sets createRule to null: nobody creates an
  // account for themselves.
  users.createRule = "@request.context = 'oauth2'";
  users.deleteRule = null;
  users.listRule = "id = @request.auth.id";
  users.viewRule = "id = @request.auth.id";

  // A person may edit their own record but may NOT set their own role. Without the
  // isset guard, `PATCH /api/collections/users/records/<self> {"role":"admin"}` is a
  // self-service privilege escalation that needs no bug to exploit — just the API.
  users.updateRule = "id = @request.auth.id && @request.body.role:isset = false";

  // A sign-in lasts thirty minutes. PocketBase's default is 432000s, five days.
  users.authToken.duration = 1800;

  app.save(users);
}, (app) => {
  const users = app.findCollectionByNameOrId("users");
  users.authToken.duration = 432000; // back to PocketBase's own default
  const role = users.fields.getByName("role");
  if (role) {
    users.fields.removeById(role.id);
  }
  app.save(users);
});
