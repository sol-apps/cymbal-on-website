/// <reference path="../pb_data/types.d.ts" />
/*
 * Stickers: the owner can stick a hand-drawn heart or star anywhere on a post. Only
 * the owner sees them for now, so they can be tried without anyone else noticing.
 *
 * x is a fraction of the card's width, so a sticker keeps its place across screen
 * sizes; y is pixels down from the card's top, so opening comments doesn't move it.
 * Locked like every other collection: lib/stickers.js is the only way in.
 */
migrate((app) => {
  const posts = app.findCollectionByNameOrId("posts");
  const stickers = new Collection({
    type: "base",
    name: "stickers",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: "post", type: "relation", required: true, collectionId: posts.id, maxSelect: 1, cascadeDelete: true },
      { name: "kind", type: "select", required: true, values: ["heart", "star"], maxSelect: 1 },
      { name: "x", type: "number", required: false, min: 0, max: 1 },
      { name: "y", type: "number", required: false, min: 0, max: 5000 },
      { name: "rot", type: "number", required: false, min: -30, max: 30 },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE INDEX idx_stickers_post ON stickers (post, created)"],
  });
  app.save(stickers);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("stickers"));
});
