/// <reference path="../pb_data/types.d.ts" />
/*
 * Profile pictures for everyone, not just the owner. Nobody has an account, so a
 * picture belongs to a browser key the way a post does: author_key is that key's
 * hash, and posts written from the same browser show its picture.
 *
 * The image is a plain (unprotected) file so the page can show it; the rows stay
 * superuser-only like every other collection, and lib/profiles.js is the only way in.
 */
migrate((app) => {
  const profiles = new Collection({
    type: "base",
    name: "profiles",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: "author_key", type: "text", required: true, max: 64 },
      { name: "ip_hash", type: "text", required: false, max: 64 },
      { name: "image", type: "file", required: true, maxSelect: 1, maxSize: 1048576,
        mimeTypes: ["image/png", "image/jpeg", "image/webp"], protected: false },
      { name: "created", type: "autodate", onCreate: true, onUpdate: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: [
      "CREATE UNIQUE INDEX idx_profiles_key ON profiles (author_key)",
      "CREATE INDEX idx_profiles_ip_created ON profiles (ip_hash, created)",
    ],
  });
  app.save(profiles);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("profiles"));
});
