/// <reference path="../pb_data/types.d.ts" />
/*
 * Anyone can stick stickers now, signed in or not. A signed-out sticker is filed under
 * its browser key's hash, and keeps a hash of its network (`ip_hash`) so lib/stickers.js
 * can limit how many new ones arrive from one network in an hour.
 */
migrate((app) => {
  const stickers = app.findCollectionByNameOrId("stickers");
  stickers.fields.add(new TextField({ name: "ip_hash", required: false, max: 64 }));
  app.save(stickers);
}, (app) => {
  const stickers = app.findCollectionByNameOrId("stickers");
  stickers.fields.removeByName("ip_hash");
  app.save(stickers);
});
