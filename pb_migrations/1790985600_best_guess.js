/// <reference path="../pb_data/types.d.ts" />
/*
 * Best guesses: when no candidate matches exactly, the worker adds the closest one
 * anyway (match_basis "guess") and sets needs_review so the owner can check it.
 *
 * Rows already parked in `attention` for no_match or ambiguous go back to `pending`,
 * so the next sync gives each of them a guess. Down drops the field and the value;
 * any guess rows are kept, as plain metadata matches.
 */
migrate((app) => {
  const syncs = app.findCollectionByNameOrId("playlist_syncs");
  const basis = syncs.fields.getByName("match_basis");
  if (basis.values.indexOf("guess") === -1) basis.values = basis.values.concat(["guess"]);
  if (!syncs.fields.getByName("needs_review")) {
    syncs.fields.add(new BoolField({ name: "needs_review", required: false }));
  }
  app.save(syncs);

  const now = new Date().toISOString().replace("T", " ");
  app.findRecordsByFilter("playlist_syncs",
    "status = 'attention' && target_id = '' && (reason = 'no_match' || reason = 'ambiguous')", "", 0, 0)
    .forEach((r) => {
      r.set("status", "pending");
      r.set("attempts", 0);
      r.set("next_at", now);
      r.set("reason", "");
      r.set("detail", "");
      app.save(r);
    });
}, (app) => {
  app.findRecordsByFilter("playlist_syncs", "match_basis = 'guess'", "", 0, 0).forEach((r) => {
    r.set("match_basis", "metadata");
    app.save(r);
  });
  const syncs = app.findCollectionByNameOrId("playlist_syncs");
  const basis = syncs.fields.getByName("match_basis");
  basis.values = basis.values.filter((v) => v !== "guess");
  syncs.fields.removeByName("needs_review");
  app.save(syncs);
});
