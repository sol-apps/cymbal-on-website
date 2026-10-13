/// <reference path="../pb_data/types.d.ts" />
/*
 * What the owner-only features need underneath (features.js switches them on):
 *
 *   - listens: one row per post per browser that played with that post's player, so
 *     a post's listen count is unique browsers, not clicks. posts.listen_count keeps
 *     the total, the way comment_count does.
 *   - sticker_kinds: PNGs the owner uploads as new stickers. The image is a plain
 *     (unprotected) file, so the page can show it to everyone; the rows themselves
 *     stay superuser-only like every other collection.
 *   - stickers.custom: a sticker made from one of those uploads. Removing the upload
 *     takes its placed stickers with it. `kind` stays for the built-in heart and star.
 */
migrate((app) => {
  const posts = app.findCollectionByNameOrId("posts");
  posts.fields.add(new NumberField({ name: "listen_count", required: false, onlyInt: true }));
  app.save(posts);

  const listens = new Collection({
    type: "base",
    name: "listens",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: "post", type: "relation", required: true, collectionId: posts.id, maxSelect: 1, cascadeDelete: true },
      { name: "author_key", type: "text", required: true, max: 64 },
      { name: "ip_hash", type: "text", required: false, max: 64 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_listens_one_each ON listens (post, author_key)",
      "CREATE INDEX idx_listens_key_created ON listens (author_key, created)",
      "CREATE INDEX idx_listens_ip_created ON listens (ip_hash, created)",
    ],
  });
  app.save(listens);

  const kinds = new Collection({
    type: "base",
    name: "sticker_kinds",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: "label", type: "text", required: true, max: 32 },
      { name: "image", type: "file", required: true, maxSelect: 1, maxSize: 1048576, mimeTypes: ["image/png"], protected: false },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    ],
  });
  app.save(kinds);

  const stickers = app.findCollectionByNameOrId("stickers");
  stickers.fields.getByName("kind").required = false;
  stickers.fields.add(new RelationField({ name: "custom", required: false, collectionId: kinds.id, maxSelect: 1, cascadeDelete: true }));
  app.save(stickers);
}, (app) => {
  const stickers = app.findCollectionByNameOrId("stickers");
  app.findRecordsByFilter("stickers", "custom != ''", "", 0, 0).forEach((r) => app.delete(r));
  stickers.fields.removeByName("custom");
  stickers.fields.getByName("kind").required = true;
  app.save(stickers);
  app.delete(app.findCollectionByNameOrId("sticker_kinds"));
  app.delete(app.findCollectionByNameOrId("listens"));
  const posts = app.findCollectionByNameOrId("posts");
  posts.fields.removeByName("listen_count");
  app.save(posts);
});
