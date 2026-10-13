/// <reference path="../pb_data/types.d.ts" />
/*
 * Profile pictures move from browsers to accounts: a picture now belongs to a signed-in
 * account (profiles.author_key = "user:" + its id) and shows on the posts that account
 * makes. The pictures set per browser before this are removed; there was no way to
 * tell which account, if any, they belonged to.
 *
 * Anyone signed in can now submit a sticker, so sticker_kinds records who did
 * (`author`, an account id) for the per-account limit. Only the owner removes one.
 */
migrate((app) => {
  app.findRecordsByFilter("profiles", "author_key !~ 'user:%'", "", 0, 0).forEach((r) => app.delete(r));
  const kinds = app.findCollectionByNameOrId("sticker_kinds");
  kinds.fields.add(new TextField({ name: "author", required: false, max: 15 }));
  app.save(kinds);
}, (app) => {
  const kinds = app.findCollectionByNameOrId("sticker_kinds");
  kinds.fields.removeByName("author");
  app.save(kinds);
});
