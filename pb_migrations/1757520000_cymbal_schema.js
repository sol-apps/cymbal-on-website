/// <reference path="../pb_data/types.d.ts" />
/*
 * Cymbal's schema: posts, comments, and the playlist-sync machinery behind them.
 *
 * EVERY collection here has every API rule null — superuser-only. The browser never
 * reads or writes /api/collections/* for Cymbal data; it goes through the
 * /api/cymbal/* hook routes, which authenticate the caller, enforce ownership and
 * rate limits, and decide what is safe to return. That is what keeps author ids,
 * provider tokens, raw provider responses and match evidence off the wire.
 *
 * Dates the worker compares (next_at, lease_until, ...) are `date` fields written
 * as "YYYY-MM-DD HH:MM:SS.sssZ", the format PocketBase stores and filters on.
 */
migrate((app) => {
  const users = app.findCollectionByNameOrId("users");
  const PROVIDERS = ["spotify", "apple_music", "youtube"];
  const locked = { listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null };
  const stamps = [
    { name: "created", type: "autodate", onCreate: true, onUpdate: false },
    { name: "updated", type: "autodate", onCreate: true, onUpdate: true },
  ];

  const posts = new Collection(Object.assign({
    type: "base",
    name: "posts",
    fields: [
      { name: "author", type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: false },
      // What was submitted is authoritative and never rewritten after creation.
      { name: "source_provider", type: "select", required: true, values: PROVIDERS, maxSelect: 1 },
      { name: "source_id", type: "text", required: true, max: 64 },
      { name: "storefront", type: "text", required: false, max: 2 },
      { name: "canonical_url", type: "text", required: true, max: 200 },
      { name: "caption", type: "text", required: false, max: 500 },
      // Resolved from the source provider by the worker, never from the request.
      { name: "title", type: "text", required: false, max: 300 },
      { name: "artist", type: "text", required: false, max: 300 },
      { name: "duration_ms", type: "number", required: false, onlyInt: true },
      { name: "isrc", type: "text", required: false, max: 12 },
      { name: "meta_status", type: "select", required: true, values: ["pending", "resolved", "failed"], maxSelect: 1 },
      { name: "meta_attempts", type: "number", required: false, onlyInt: true },
      { name: "meta_next_at", type: "date", required: false },
      { name: "request_id", type: "text", required: true, max: 64 },
      { name: "comment_count", type: "number", required: false, onlyInt: true },
      // Deletion blanks the caption and hides the post. It does NOT remove the row:
      // rate limits count deleted posts, and playlists are append-only in v1.
      { name: "deleted", type: "bool", required: false },
      { name: "deleted_by", type: "select", required: false, values: ["author", "admin"], maxSelect: 1 },
      { name: "deleted_at", type: "date", required: false },
    ].concat(stamps),
    indexes: [
      "CREATE UNIQUE INDEX idx_posts_request ON posts (author, request_id)",
      "CREATE INDEX idx_posts_feed ON posts (deleted, created, id)",
      "CREATE INDEX idx_posts_author_created ON posts (author, created)",
      "CREATE INDEX idx_posts_meta ON posts (meta_status, meta_next_at)",
    ],
  }, locked));
  app.save(posts);

  const comments = new Collection(Object.assign({
    type: "base",
    name: "comments",
    fields: [
      { name: "post", type: "relation", required: true, collectionId: posts.id, maxSelect: 1, cascadeDelete: true },
      { name: "author", type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: false },
      { name: "body", type: "text", required: false, max: 1000 },
      { name: "request_id", type: "text", required: true, max: 64 },
      { name: "deleted", type: "bool", required: false },
      { name: "deleted_by", type: "select", required: false, values: ["author", "admin"], maxSelect: 1 },
      { name: "deleted_at", type: "date", required: false },
    ].concat(stamps),
    indexes: [
      "CREATE UNIQUE INDEX idx_comments_request ON comments (author, request_id)",
      "CREATE INDEX idx_comments_post ON comments (post, created)",
      "CREATE INDEX idx_comments_author_created ON comments (author, created)",
    ],
  }, locked));
  app.save(comments);

  // One row per (post, target provider): exactly three per post.
  const syncs = new Collection(Object.assign({
    type: "base",
    name: "playlist_syncs",
    fields: [
      { name: "post", type: "relation", required: true, collectionId: posts.id, maxSelect: 1, cascadeDelete: true },
      { name: "target", type: "select", required: true, values: PROVIDERS, maxSelect: 1 },
      // pending        waiting for the worker (or for the provider to be connected)
      // pending_device matched; Apple writes wait for the owner's authorised browser
      // synced         the item is in the owner's playlist
      // attention      no unique high-confidence match, or the provider refused it
      // cancelled      the post was deleted before the item was added
      { name: "status", type: "select", required: true,
        values: ["pending", "pending_device", "synced", "attention", "cancelled"], maxSelect: 1 },
      { name: "match_basis", type: "select", required: false,
        values: ["source", "isrc", "musicbrainz", "metadata", "manual"], maxSelect: 1 },
      { name: "target_id", type: "text", required: false, max: 64 },
      { name: "target_url", type: "text", required: false, max: 200 },
      { name: "evidence", type: "json", required: false, maxSize: 20000 },
      { name: "reason", type: "text", required: false, max: 60 },
      { name: "detail", type: "text", required: false, max: 1000 },
      { name: "attempts", type: "number", required: false, onlyInt: true },
      { name: "next_at", type: "date", required: false },
      { name: "lease_until", type: "date", required: false },
      { name: "lease_token", type: "text", required: false, max: 40 },
      // Set after a write whose outcome is unknown (timeout, 5xx): the next attempt
      // reads the remote playlist before writing, so a retry never adds twice.
      { name: "needs_verify", type: "bool", required: false },
      { name: "synced_at", type: "date", required: false },
    ].concat(stamps),
    indexes: [
      "CREATE UNIQUE INDEX idx_syncs_post_target ON playlist_syncs (post, target)",
      "CREATE INDEX idx_syncs_due ON playlist_syncs (status, next_at)",
      "CREATE INDEX idx_syncs_target_status ON playlist_syncs (target, status)",
    ],
  }, locked));
  app.save(syncs);

  // What is in each playlist, as far as Cymbal has written it. The unique index is
  // the deduplication: a second post of the same song finds its row and stops.
  const memberships = new Collection(Object.assign({
    type: "base",
    name: "playlist_memberships",
    fields: [
      { name: "provider", type: "select", required: true, values: PROVIDERS, maxSelect: 1 },
      { name: "playlist_id", type: "text", required: true, max: 100 },
      { name: "item_id", type: "text", required: true, max: 64 },
      { name: "sync", type: "relation", required: false, collectionId: syncs.id, maxSelect: 1, cascadeDelete: false },
    ].concat(stamps),
    indexes: [
      "CREATE UNIQUE INDEX idx_memberships_item ON playlist_memberships (provider, playlist_id, item_id)",
    ],
  }, locked));
  app.save(memberships);

  // The owner's three accounts. Tokens are AES-encrypted with CYMBAL_TOKEN_KEY
  // before they are stored; Apple's Music User Token is never sent here at all.
  const connections = new Collection(Object.assign({
    type: "base",
    name: "provider_connections",
    fields: [
      { name: "provider", type: "select", required: true, values: PROVIDERS, maxSelect: 1 },
      { name: "status", type: "select", required: true, values: ["disconnected", "connected", "needs_reauth"], maxSelect: 1 },
      { name: "account_label", type: "text", required: false, max: 200 },
      { name: "playlist_id", type: "text", required: false, max: 100 },
      { name: "playlist_url", type: "text", required: false, max: 300 },
      { name: "access_token_enc", type: "text", required: false, max: 8000 },
      { name: "refresh_token_enc", type: "text", required: false, max: 8000 },
      { name: "token_expires_at", type: "date", required: false },
      { name: "scopes", type: "text", required: false, max: 500 },
      { name: "cooldown_until", type: "date", required: false },
      { name: "last_error", type: "text", required: false, max: 500 },
      { name: "last_ok_at", type: "date", required: false },
      // YouTube's daily budget: units, and search.list calls, which Google counts
      // against a separate allocation. Reset at the Pacific-time day boundary.
      { name: "quota_day", type: "text", required: false, max: 10 },
      { name: "quota_used", type: "number", required: false, onlyInt: true },
      { name: "search_used", type: "number", required: false, onlyInt: true },
    ].concat(stamps),
    indexes: [
      "CREATE UNIQUE INDEX idx_connections_provider ON provider_connections (provider)",
    ],
  }, locked));
  app.save(connections);

  // OAuth `state`, stored as its sha256: single-use, ten minutes, bound to the owner
  // who started the flow.
  const states = new Collection(Object.assign({
    type: "base",
    name: "oauth_states",
    fields: [
      { name: "state_hash", type: "text", required: true, max: 64 },
      { name: "provider", type: "select", required: true, values: ["spotify", "youtube"], maxSelect: 1 },
      { name: "owner", type: "relation", required: true, collectionId: users.id, maxSelect: 1, cascadeDelete: true },
      { name: "expires_at", type: "date", required: true },
      { name: "used", type: "bool", required: false },
    ].concat(stamps),
    indexes: [
      "CREATE UNIQUE INDEX idx_oauth_states_hash ON oauth_states (state_hash)",
    ],
  }, locked));
  app.save(states);
}, (app) => {
  ["oauth_states", "provider_connections", "playlist_memberships", "playlist_syncs", "comments", "posts"].forEach((name) => {
    try {
      app.delete(app.findCollectionByNameOrId(name));
    } catch (err) {
      // already gone
    }
  });
});
