/// <reference path="../pb_data/types.d.ts" />
/*
 * site_settings: switches the owner flips on Misc, one row each (`name`, `on`).
 * Superuser-only like every other collection; the hooks read and write it.
 *
 *   sticker_auto_approve  a sticker sent while signed out goes live straight away
 *                         (on), or waits for the owner to approve it (off). Starts on.
 */
migrate((app) => {
  const settings = new Collection({
    type: "base",
    name: "site_settings",
    listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null,
    fields: [
      { name: "name", type: "text", required: true, max: 64 },
      { name: "on", type: "bool", required: false },
      { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_site_settings_name ON site_settings (name)"],
  });
  app.save(settings);
  const row = new Record(settings);
  row.set("name", "sticker_auto_approve");
  row.set("on", true);
  app.save(row);
}, (app) => {
  app.delete(app.findCollectionByNameOrId("site_settings"));
});
