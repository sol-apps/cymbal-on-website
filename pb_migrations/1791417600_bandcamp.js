/// <reference path="../pb_data/types.d.ts" />
/*
 * Bandcamp posts: a friend can post a Bandcamp track, which is matched onto the three
 * playlists like any other post. Bandcamp is a source only, never a playlist target,
 * so only posts.source_provider learns the value.
 *
 * source_id grows to hold "artist-subdomain/track-slug", and embed_id keeps Bandcamp's
 * numeric track id, which its embed player needs and the link itself doesn't carry.
 * Down refuses while a Bandcamp post exists, rather than leave one unreadable.
 */
migrate((app) => {
  const posts = app.findCollectionByNameOrId("posts");
  const source = posts.fields.getByName("source_provider");
  if (source.values.indexOf("bandcamp") === -1) source.values = source.values.concat(["bandcamp"]);
  posts.fields.getByName("source_id").max = 200;
  if (!posts.fields.getByName("embed_id")) {
    posts.fields.add(new TextField({ name: "embed_id", required: false, max: 32 }));
  }
  app.save(posts);
}, (app) => {
  if (app.countRecords("posts", $dbx.hashExp({ source_provider: "bandcamp" })) > 0) {
    throw new Error("Bandcamp posts exist; remove them before migrating down.");
  }
  const posts = app.findCollectionByNameOrId("posts");
  const source = posts.fields.getByName("source_provider");
  source.values = source.values.filter((v) => v !== "bandcamp");
  posts.fields.getByName("source_id").max = 64;
  posts.fields.removeByName("embed_id");
  app.save(posts);
});
