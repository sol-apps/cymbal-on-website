/// <reference path="../pb_data/types.d.ts" />
/*
 * Anyone can submit a sticker now, signed in or not. One sent while signed out waits
 * (`waiting`) until the owner approves it on Misc, and is filed under its browser
 * key's hash (`author_key`) for the per-browser limit, with a hash of its network
 * (`ip_hash`) for the per-network one. Every sticker already here stays live.
 */
migrate((app) => {
  const kinds = app.findCollectionByNameOrId("sticker_kinds");
  kinds.fields.add(new BoolField({ name: "waiting", required: false }));
  kinds.fields.add(new TextField({ name: "author_key", required: false, max: 64 }));
  kinds.fields.add(new TextField({ name: "ip_hash", required: false, max: 64 }));
  app.save(kinds);
}, (app) => {
  const kinds = app.findCollectionByNameOrId("sticker_kinds");
  ["waiting", "author_key", "ip_hash"].forEach((f) => kinds.fields.removeByName(f));
  app.save(kinds);
});
