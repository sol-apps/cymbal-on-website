/// <reference path="../pb_data/types.d.ts" />
/*
 * Cymbal becomes pseudonymous (2026-09-10): nobody signs in to post or comment.
 *
 * A post or comment now carries the name its writer typed (`pseudonym`), the sha256 of
 * that browser's private key (`author_key` — what lets the browser remove its own
 * posts), and a salted hash of the client address (`ip_hash`, for rate limits). The
 * `users` relation stays, optional and unused, so no existing row loses anything:
 * only the owner signs in now, and only for the owner panel.
 *
 * Every API rule stays null. Reads and writes still go only through /api/cymbal/*.
 */
migrate((app) => {
  const indexes = {
    posts: [
      "CREATE UNIQUE INDEX idx_posts_key_request ON posts (author_key, request_id)",
      "CREATE INDEX idx_posts_feed ON posts (deleted, created, id)",
      "CREATE INDEX idx_posts_key_created ON posts (author_key, created)",
      "CREATE INDEX idx_posts_ip_created ON posts (ip_hash, created)",
      "CREATE INDEX idx_posts_meta ON posts (meta_status, meta_next_at)",
    ],
    comments: [
      "CREATE UNIQUE INDEX idx_comments_key_request ON comments (author_key, request_id)",
      "CREATE INDEX idx_comments_post ON comments (post, created)",
      "CREATE INDEX idx_comments_key_created ON comments (author_key, created)",
      "CREATE INDEX idx_comments_ip_created ON comments (ip_hash, created)",
    ],
  };
  Object.keys(indexes).forEach((name) => {
    const c = app.findCollectionByNameOrId(name);
    c.fields.getByName("author").required = false;
    c.fields.add(new TextField({ name: "pseudonym", required: false, max: 32 }));
    c.fields.add(new TextField({ name: "author_key", required: false, max: 64 }));
    c.fields.add(new TextField({ name: "ip_hash", required: false, max: 64 }));
    c.indexes = indexes[name];
    app.save(c);
  });
}, (app) => {
  const indexes = {
    posts: [
      "CREATE UNIQUE INDEX idx_posts_request ON posts (author, request_id)",
      "CREATE INDEX idx_posts_feed ON posts (deleted, created, id)",
      "CREATE INDEX idx_posts_author_created ON posts (author, created)",
      "CREATE INDEX idx_posts_meta ON posts (meta_status, meta_next_at)",
    ],
    comments: [
      "CREATE UNIQUE INDEX idx_comments_request ON comments (author, request_id)",
      "CREATE INDEX idx_comments_post ON comments (post, created)",
      "CREATE INDEX idx_comments_author_created ON comments (author, created)",
    ],
  };
  Object.keys(indexes).forEach((name) => {
    const c = app.findCollectionByNameOrId(name);
    ["pseudonym", "author_key", "ip_hash"].forEach((f) => {
      const field = c.fields.getByName(f);
      if (field) c.fields.removeById(field.id);
    });
    // `author` stays optional on the way down too: a pseudonymous row has none.
    c.indexes = indexes[name];
    app.save(c);
  });
});
