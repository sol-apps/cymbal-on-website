/// <reference path="../pb_data/types.d.ts" />
/*
 * Closer guesses: matching now scores length and artist names more loosely, and keeps
 * the closest candidate for the owner to pick when nothing is close enough to add.
 *
 * Rows parked in `attention` for no_match or ambiguous go back to `pending` once, so
 * each is scored again: some become guesses, the rest gain a closest candidate. No
 * schema change, so down has nothing to undo.
 */
migrate((app) => {
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
}, () => {});
