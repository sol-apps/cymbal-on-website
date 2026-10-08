/// <reference path="../pb_data/types.d.ts" />
/*
 * Stickers go public: everyone sees them, and each person gets one per post.
 *
 * author_key says whose sticker it is, the way it does on posts and comments. Only
 * the owner can place one for now, and theirs are all "owner" whichever browser they
 * used. Everything placed so far was the owner trying it out, so those rows become
 * the owner's, and where a post had several only the newest stays.
 */
migrate((app) => {
  const stickers = app.findCollectionByNameOrId("stickers");
  stickers.fields.add(new TextField({ name: "author_key", max: 64 }));
  app.save(stickers);

  const seen = {};
  app.findRecordsByFilter("stickers", "id != ''", "-created", 0, 0).forEach((r) => {
    const post = r.getString("post");
    if (seen[post]) {
      app.delete(r);
      return;
    }
    seen[post] = true;
    r.set("author_key", "owner");
    app.save(r);
  });

  stickers.indexes = [
    "CREATE INDEX idx_stickers_post ON stickers (post, created)",
    "CREATE UNIQUE INDEX idx_stickers_one_each ON stickers (post, author_key)",
  ];
  app.save(stickers);
}, (app) => {
  const stickers = app.findCollectionByNameOrId("stickers");
  stickers.indexes = ["CREATE INDEX idx_stickers_post ON stickers (post, created)"];
  stickers.fields.removeByName("author_key");
  app.save(stickers);
});
