/* app.js — Cymbal's page. Plain DOM, no framework, no build step.
 *
 * Every piece of text that came from a person or a provider — names, captions,
 * comments, track titles — reaches the page through textContent (h() below) and is
 * never parsed as HTML. Links are only ever https URLs the server built from
 * validated ids.
 *
 * Nobody signs in to post. This browser gets a random private key the first time the
 * page loads and sends it as X-Cymbal-Key; the server stores only its hash, and it is
 * what lets this browser remove its own posts. The typed name is remembered here.
 * Anyone can make an account and sign in from the top bar, with an email and password;
 * a session lasts seven days and is never renewed silently (pb-auth.js).
 *
 * The same file runs misc.html, the second page (body data-page="misc"): your
 * picture, playlists, theme, most reacts, and for the owner the owner panel. It has
 * no composer or feed. New features are switched on per
 * audience in features.js; on() below is the only thing that reads it.
 */
(() => {
  "use strict";

  const pb = PBAuth.getClient();
  pb.autoCancellation(false);

  const $ = (id) => document.getElementById(id);
  const ORDER = ["spotify", "apple_music", "youtube"];
  const LABELS = { spotify: "Spotify", apple_music: "Apple Music", youtube: "YouTube", bandcamp: "Bandcamp" };
  const STATE_TEXT = { pending: "pending", synced: "synced", attention: "attention", cancelled: "cancelled" };
  const STATE_MARK = { pending: "…", synced: "✓", attention: "!", cancelled: "×" };
  const PAGE = document.body.dataset.page || "feed";
  const onFeed = PAGE === "feed";

  // ── features (features.js) ────────────────────────────────────────────────
  // "members" features are drawn for anyone signed in, "owner" ones only for the
  // owner. Each one also puts an ff-<name> class on <html> so the stylesheet can
  // follow the same switch.

  let ownerNow = PBAuth.isAdmin();
  let memberNow = PBAuth.isSignedIn();

  function on(name) {
    const v = (typeof FEATURES === "object" && FEATURES) ? FEATURES[name] : "off";
    return v === "all" || (v === "members" && memberNow) || (v === "owner" && ownerNow);
  }

  function applyFeatures() {
    if (typeof FEATURES !== "object") return;
    Object.keys(FEATURES).forEach((k) => document.documentElement.classList.toggle("ff-" + k, on(k)));
  }

  // ── tiny helpers ──────────────────────────────────────────────────────────

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = v;
        else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const c of kids.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function safeHref(url) {
    return typeof url === "string" && /^https:\/\/[a-z0-9.-]+\//i.test(url) ? url : null;
  }

  function extLink(url, text, cls) {
    const href = safeHref(url);
    if (!href) return h("span", { class: cls }, text);
    return h("a", { href: href, target: "_blank", rel: "noopener noreferrer", class: cls }, text);
  }

  function say(id, text, kind) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", kind === "error");
    el.classList.toggle("is-ok", kind === "ok");
  }

  function randomHex(bytes) {
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function requestId() {
    return window.crypto && crypto.randomUUID ? crypto.randomUUID() : randomHex(16);
  }

  function when(stamp) {
    const t = Date.parse(String(stamp || "").replace(" ", "T"));
    if (isNaN(t)) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " h ago";
    if (s < 7 * 86400) return Math.floor(s / 86400) + " d ago";
    return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  function clock(stamp) {
    const t = Date.parse(String(stamp || "").replace(" ", "T"));
    return isNaN(t) ? "" : new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }

  // ── this browser: its key and its name ───────────────────────────────────

  const store = {
    get(k) { try { return localStorage.getItem(k) || ""; } catch (_) { return ""; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* storage blocked */ } },
  };
  let memoryKey = "";

  // Where storage is blocked the key lives for this page only, so posts made then
  // can't be removed from this browser later. Nothing else changes.
  function browserKey() {
    let key = store.get("cymbal_key");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) {
      key = memoryKey || randomHex(32);
      memoryKey = key;
      store.set("cymbal_key", key);
    }
    return key;
  }

  function savedName() { return store.get("cymbal_name"); }
  function rememberName(name) { if (name) store.set("cymbal_name", name); }

  async function api(path, opts) {
    const o = Object.assign({ method: "GET" }, opts || {});
    o.headers = Object.assign({ "X-Cymbal-Key": browserKey() }, o.headers || {});
    try {
      return await pb.send(path, o);
    } catch (err) {
      const status = err && err.status;
      if (status === 401 && PBAuth.isSignedIn()) PBAuth.signOut();
      const msg = (err && err.response && err.response.message) ||
        (status === 0 ? "Couldn't reach Cymbal. Check your connection." : "Something went wrong. Try again.");
      const e = new Error(msg);
      e.status = status;
      throw e;
    }
  }

  let pollTimer = null;
  let appleTimer = null;

  // ── composer ──────────────────────────────────────────────────────────────

  // One request id per attempt at a post, kept until it succeeds, so a retry after a
  // dropped connection returns the original post instead of creating a second one.
  let postRid = null;

  // The composer starts as one field; the rest opens once there is a link to share.
  // A remembered name shows as "Posting as …" instead of an empty box.
  function openComposer() { $("composer-more").hidden = false; }

  function showName(editing) {
    const name = savedName();
    const known = !!name && !editing;
    $("name").hidden = known;
    $("name").previousElementSibling.hidden = known;
    $("name-known").hidden = !known;
    $("name-shown").textContent = name;
  }

  function linkKind(url) {
    const m = /^https:\/\/([a-z0-9.-]+)\//i.exec(url);
    if (!m) return "";
    const host = m[1].toLowerCase();
    if (host === "open.spotify.com" || host === "spotify.link") return "Spotify";
    if (host === "music.apple.com" || host === "itunes.apple.com") return "Apple Music";
    if (/(^|\.)youtube\.com$/.test(host) || host === "youtu.be") return "YouTube";
    if (/^[a-z0-9-]+\.bandcamp\.com$/.test(host)) return "Bandcamp";
    return "?";
  }

  // Only the feed page has a composer.
  function setupComposer() {
    $("name").value = savedName();
    showName(false);
    $("name-change").addEventListener("click", () => { showName(true); $("name").focus(); $("name").select(); });
    $("url").addEventListener("input", () => {
      postRid = null;
      const url = $("url").value.trim();
      const kind = url ? linkKind(url) : "";
      const tag = $("url-kind");
      tag.textContent = kind === "?" ? "Not a supported link" : kind;
      tag.className = "url-kind" + (kind === "?" ? " is-bad" : kind ? " is-good" : "");
      if (url) openComposer();
      // Cleared with nothing else typed: fold back to the one field.
      else if (!$("caption").value.trim()) $("composer-more").hidden = true;
      say("composer-status", "");
    });
    $("url").addEventListener("paste", () => setTimeout(() => { if ($("url").value.trim()) $("caption").focus(); }, 0));
    $("caption").addEventListener("input", () => {
      $("caption-count").textContent = $("caption").value.length + "/500";
    });

    $("composer").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const url = $("url").value.trim();
      const name = $("name").value.trim();
      if (!url) {
        say("composer-status", "Paste a song link first.", "error");
        $("url").focus();
        return;
      }
      if (name.length < 2) {
        say("composer-status", "Add your name.", "error");
        openComposer();
        showName(true);
        $("name").focus();
        return;
      }
      if (!postRid) postRid = requestId();
      const btn = $("post");
      btn.disabled = true;
      say("composer-status", "Posting…");
      try {
        const res = await api("/api/cymbal/posts", {
          method: "POST",
          body: { url: url, name: name, caption: $("caption").value, request_id: postRid },
        });
        postRid = null;
        rememberName(name);
        $("url").value = "";
        $("caption").value = "";
        $("caption-count").textContent = "0/500";
        $("url-kind").textContent = "";
        $("composer-more").hidden = true;
        showName(false);
        upsertCard(res.post, true);
        say("composer-status", res.replayed ? "Already posted." : "Posted. It'll be added to the playlists shortly.", "ok");
      } catch (err) {
        if (err.status >= 400 && err.status < 500) postRid = null;
        say("composer-status", err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ── feed ──────────────────────────────────────────────────────────────────

  let cursor = "";
  let loading = false;

  async function loadFeed(reset) {
    if (loading) return;
    loading = true;
    if (reset) {
      cursor = "";
      $("posts").replaceChildren(skeleton(), skeleton());
      $("posts").classList.add("is-loading");
    }
    say("feed-status", reset ? "" : "Loading…");
    try {
      const q = cursor ? "?cursor=" + encodeURIComponent(cursor) : "";
      const data = await api("/api/cymbal/feed" + q);
      if (reset) $("posts").replaceChildren();
      data.posts.forEach((p) => upsertCard(p, false));
      cursor = data.next_cursor || "";
      $("more").hidden = !cursor;
      const empty = !$("posts").children.length;
      say("feed-status", "");
      if (empty) $("posts").replaceChildren(h("li", { class: "empty panel" },
        h("span", { class: "brand-mark big", "aria-hidden": "true" }), h("p", null, "Nothing here yet. Post the first song.")));
    } catch (err) {
      if (reset) $("posts").replaceChildren();
      say("feed-status", err.message, "error");
    } finally {
      loading = false;
    }
  }

  function skeleton() {
    return h("li", { class: "card panel skel", "aria-hidden": "true" },
      h("span", { class: "skel-line short" }), h("span", { class: "skel-line" }), h("span", { class: "skel-line mid" }));
  }

  // Re-read the newest page so titles resolve and sync states move without a reload.
  async function refreshTop() {
    if (carry) return; // a sticker in hand would be redrawn under the finger
    try {
      const data = await api("/api/cymbal/feed");
      data.posts.slice().reverse().forEach((p) => upsertCard(p, true));
    } catch (_) { /* next tick */ }
  }

  // All three waiting is the normal state for a new post: say it once, not three times.
  function syncChips(p) {
    const states = ORDER.map((prov) => (p.sync && p.sync[prov]) || { state: "pending" });
    if (states.every((s) => (STATE_TEXT[s.state] || "pending") === "pending")) {
      return h("p", { class: "syncs-wait" }, h("span", { class: "sync-mark", "aria-hidden": "true" }, "…"), "Adding to the playlists");
    }
    return h("ul", { class: "syncs", "aria-label": "Playlist status" }, ORDER.map((prov, i) => {
      const s = states[i];
      const state = STATE_TEXT[s.state] || "pending";
      const inner = [h("span", { class: "sync-mark", "aria-hidden": "true" }, STATE_MARK[state]),
        LABELS[prov], h("span", { class: "visually-hidden" }, " " + state)];
      return h("li", { class: "sync sync-" + state, title: LABELS[prov] + ": " + state },
        s.url && safeHref(s.url) ? h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, inner) : inner);
    }));
  }

  // A stable colour per name, so people are recognisable down the feed.
  function avatar(name) {
    let n = 0;
    for (const ch of String(name)) n = (n * 31 + ch.codePointAt(0)) >>> 0;
    const first = Array.from(String(name).trim())[0] || "?";
    return h("span", { class: "avatar av-" + (n % 6), "aria-hidden": "true" }, first.toUpperCase());
  }

  // Same-origin profile pictures only: PocketBase's /api/files/profiles/.
  function safePic(src) {
    return typeof src === "string" && /^\/api\/files\/profiles\/[a-z0-9]{15}\/[A-Za-z0-9_.%-]+$/.test(src);
  }

  function picAvatar(src) {
    return h("img", { class: "avatar avatar-pic", src: src, alt: "", loading: "lazy" });
  }

  // The poster's picture if their browser set one; otherwise a letter, but (with
  // accountAvatars) only for a post made from an account, and nothing at all for the rest.
  function posterAvatar(p) {
    if (on("profilePics") && safePic(p.pic)) return picAvatar(p.pic);
    if (on("accountAvatars") && !p.account) return null;
    return avatar(p.poster);
  }

  // The embed for a post's own link, built only from the id in a canonical URL the
  // server produced. Every card shows its player, loaded lazily so only the posts
  // near the screen talk to Spotify, Google, Apple or Bandcamp. Nothing autoplays.
  // Bandcamp's player wants its numeric track id, which the server read from the page.
  function embedFor(p) {
    const url = p.url;
    let m;
    if ((m = /^https:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]{22})$/.exec(url))) {
      return { src: "https://open.spotify.com/embed/track/" + m[1], cls: "player-spotify" };
    }
    if ((m = /^https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/.exec(url))) {
      return { src: "https://www.youtube-nocookie.com/embed/" + m[1], cls: "player-youtube" };
    }
    if ((m = /^https:\/\/music\.apple\.com\/([a-z]{2})\/song\/([0-9]{1,15})$/.exec(url))) {
      return { src: "https://embed.music.apple.com/" + m[1] + "/song/" + m[2], cls: "player-apple" };
    }
    if (/^https:\/\/[a-z0-9-]+\.bandcamp\.com\/track\/[a-z0-9-]+$/.test(url) && /^[0-9]{1,15}$/.test(p.embed_id || "")) {
      return { src: "https://bandcamp.com/EmbeddedPlayer/track=" + p.embed_id + "/size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/artwork=small/transparent=true/", cls: "player-bandcamp" };
    }
    return null;
  }

  function player(p) {
    const e = embedFor(p);
    if (!e) return null;
    return h("div", { class: "player " + e.cls },
      h("iframe", {
        src: e.src, title: "Player: " + (p.title || p.source_label + " track"), loading: "lazy",
        allow: "clipboard-write; encrypted-media; fullscreen; picture-in-picture",
        referrerpolicy: "strict-origin-when-cross-origin",
      }));
  }

  function buildCard(p) {
    // A lookup that never finished (the provider isn't connected yet, say) shouldn't
    // read as "finding…" for days; after a while it is just "a Spotify track".
    const stale = Date.now() - Date.parse(String(p.created || "").replace(" ", "T")) > 15 * 60 * 1000;
    const fallback = (p.source_label || "Unknown") + " track";
    const title = p.title || (p.unavailable ? "Couldn't look this one up" : (p.resolving && !stale ? "Finding the track details…" : fallback));
    const count = p.comment_count || 0;
    const compact = on("compactCards");
    // Signed in: a small comment icon with the stickers in a row beside it.
    const merged = on("stickerButton") && on("openComments") && memberNow;
    const remove = p.can_delete ? (compact
      ? h("button", { class: "btn-x", type: "button", title: "Remove this post", "aria-label": "Remove this post", onclick: () => removePost(p.id) }, "✕")
      : h("button", { class: "btn-remove", type: "button", onclick: () => removePost(p.id) },
        h("span", { "aria-hidden": "true" }, "✕"), "Remove")) : null;
    const card = h("li", { class: "card panel", "data-id": p.id, "data-count": count },
      h("div", { class: "card-head" },
        posterAvatar(p),
        h("span", { class: "who" }, h("strong", null, p.poster), h("span", { class: "when" }, when(p.created),
          on("listenCount") ? h("span", { class: "listens", title: "Browsers that played this" },
            " · ", h("span", { "aria-hidden": "true" }, "♪ "), h("span", { class: "js-listens" }, String(p.listen_count || 0)),
            h("span", null, p.listen_count === 1 ? " listen" : " listens")) : null)),
        compact ? remove : h("span", { class: "src src-" + (p.source || "x") }, (p.source_label || "").toUpperCase())),
      p.caption ? h("p", { class: "caption" }, p.caption) : null,
      // The player already shows the song and artist, so compact cards leave them to
      // it; a post with no player still says what it is, on one line.
      compact && embedFor(p) ? null : compact
        // One line: "Title - Artist", the artist quieter.
        ? h("div", { class: "song" },
          h("h3", { class: "track" + (p.title ? "" : " resolving") }, extLink(p.url, title),
            p.artist ? h("span", { class: "artist-inline" }, " - " + p.artist) : null))
        : h("div", { class: "song" },
          h("h3", { class: "track" + (p.title ? "" : " resolving") }, extLink(p.url, title)),
          p.artist ? h("p", { class: "artist" }, p.artist) : null),
      player(p),
      compact ? null : syncChips(p),
      h("div", { class: "card-actions" },
        h("button", {
          class: merged ? "comment-btn js-toggle" : "btn btn-small js-toggle" + (on("plusComment") ? " btn-tiny" : ""), type: "button",
          "aria-expanded": "false", "aria-controls": "c-" + p.id,
          "aria-label": merged ? "Comment on this post" : null,
          title: merged ? "Comment" : null,
          onclick: (ev) => (on("openComments") ? toggleCommentForm : toggleComments)(ev.currentTarget.closest(".card"), p.id),
        }, h("span", { class: "js-count-label", "aria-hidden": merged ? "true" : null }, merged ? "" : commentLabel(count))),
        compact ? null : remove),
      h("div", { class: "comments", id: "c-" + p.id, hidden: true }),
      p.stickers && p.stickers.length ? stickerLayer(p) : null);
    if (merged) {
      const tray = stickerTray(card, p.id);
      tray.append(h("a", { class: "sticker-add", href: "misc.html#sticker-admin", title: "Submit your own sticker", "aria-label": "Submit your own sticker" }));
      card.querySelector(".comment-btn").after(tray);
    }
    if (on("openComments")) fillThread(card, p);
    return card;
  }

  // Replace a card in place, keeping an open comment thread and the player (the feed
  // refreshes every 45 seconds, which must not stop the music), or add it.
  function upsertCard(p, atTop) {
    const list = $("posts");
    const old = list.querySelector('li[data-id="' + CSS.escape(p.id) + '"]');
    const card = buildCard(p);
    const placeholder = list.querySelector(".empty");
    if (placeholder) placeholder.remove();
    if (old) {
      const oldComments = old.querySelector(".comments");
      // An open thread stays as it is. Where every thread is open, only one being
      // written in or unfolded stays; the rest take the fresh comments.
      const busy = oldComments && (oldComments.querySelector("form") || oldComments.dataset.expanded === "1");
      if (oldComments && !oldComments.hidden && (!on("openComments") || busy)) {
        card.querySelector(".comments").replaceWith(oldComments);
        card.querySelector(".js-toggle").setAttribute("aria-expanded", "true");
      }
      const oldPlayer = old.querySelector(".player");
      const freshPlayer = card.querySelector(".player");
      if (oldPlayer && freshPlayer) {
        // An iframe reloads the moment it leaves the document, so the player never
        // moves: the refreshed card's other parts move in around it instead.
        const parts = [...card.children];
        const at = parts.indexOf(freshPlayer);
        old.dataset.count = card.dataset.count;
        [...old.children].forEach((c) => { if (c !== oldPlayer) c.remove(); });
        oldPlayer.before(...parts.slice(0, at));
        oldPlayer.after(...parts.slice(at + 1));
      } else {
        old.replaceWith(card);
      }
    } else if (atTop) {
      list.prepend(card);
    } else {
      list.append(card);
    }
    $("posts").classList.remove("is-loading");
    say("feed-status", "");
  }

  async function removePost(id) {
    if (!confirm("Remove this post? Songs already added to the playlists stay there.")) return;
    try {
      await api("/api/cymbal/posts/" + encodeURIComponent(id), { method: "DELETE" });
      const el = $("posts").querySelector('li[data-id="' + CSS.escape(id) + '"]');
      if (el) el.remove();
      say("feed-status", "Post removed.", "ok");
    } catch (err) {
      say("feed-status", err.message, "error");
    }
  }

  // ── comments ──────────────────────────────────────────────────────────────

  async function toggleComments(card, postId) {
    const box = card.querySelector(".comments");
    const btn = card.querySelector(".js-toggle");
    if (!box.hidden) {
      box.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      return;
    }
    box.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    box.replaceChildren(h("p", { class: "small", role: "status" }, "Loading comments…"));
    let data;
    try {
      data = await api("/api/cymbal/posts/" + encodeURIComponent(postId) + "/comments");
    } catch (err) {
      box.replaceChildren(h("p", { class: "status is-error", role: "status" }, err.message));
      return;
    }
    const list = h("ol", { class: "comment-list" }, data.comments.map((c) => commentItem(c, card)));
    box.replaceChildren(list, commentForm(postId, list, card));
  }

  function commentItem(c, card) {
    const li = h("li", { class: "comment" },
      h("div", { class: "comment-meta" }, h("strong", null, c.poster), h("span", null, when(c.created)),
        c.can_delete ? h("button", { class: "link-btn", type: "button", onclick: async () => {
          if (!confirm("Remove this comment?")) return;
          try {
            await api("/api/cymbal/comments/" + encodeURIComponent(c.id), { method: "DELETE" });
            const at = li.closest(".card") || card;
            li.remove();
            bumpCount(at, -1);
          } catch (err) { alert(err.message); }
        } }, "remove") : null),
      h("p", { class: "comment-body" }, c.body));
    return li;
  }

  function commentLabel(n) {
    if (on("openComments")) return "+ COMMENT";
    if (on("plusComment")) return n ? "+ COMMENT (" + n + ")" : "+ COMMENT";
    return n ? "COMMENTS (" + n + ")" : "COMMENT";
  }

  function bumpCount(card, delta) {
    const n = Math.max(0, Number(card.dataset.count || 0) + delta);
    card.dataset.count = n;
    const label = card.querySelector(".js-count-label");
    if (!card.querySelector(".comment-btn")) label.textContent = commentLabel(n);
    if (on("openComments")) foldButton(card);
  }

  // ── comments shown on the card (openComments) ─────────────────────────────
  // The feed brings each post's first three comments. More than three folds behind
  // SHOW N MORE, which fetches the rest; + COMMENT opens the form under them.

  const FOLD = 3;

  function fillThread(card, p) {
    const box = card.querySelector(".comments");
    const list = h("ol", { class: "comment-list is-folded" }, (p.comments || []).map((c) => commentItem(c, card)));
    box.replaceChildren(list, h("button", { class: "link-btn more-comments", type: "button", hidden: true,
      onclick: (ev) => unfold(ev.currentTarget.closest(".card")) }));
    box.hidden = !list.children.length;
    foldButton(card);
  }

  function foldButton(card) {
    const box = card.querySelector(".comments");
    const btn = box.querySelector(".more-comments");
    const list = box.querySelector(".comment-list");
    if (!btn || !list) return;
    const n = Number(card.dataset.count || 0);
    const folded = list.classList.contains("is-folded");
    btn.hidden = n <= FOLD;
    btn.textContent = folded ? "SHOW " + (n - FOLD) + " MORE" : "SHOW FEWER";
    btn.setAttribute("aria-expanded", String(!folded));
  }

  async function unfold(card) {
    const box = card.querySelector(".comments");
    const list = box.querySelector(".comment-list");
    if (!list.classList.contains("is-folded")) {
      list.classList.add("is-folded");
      box.dataset.expanded = "0";
      foldButton(card);
      return;
    }
    if (list.children.length < Number(card.dataset.count || 0)) {
      try {
        const data = await api("/api/cymbal/posts/" + encodeURIComponent(card.dataset.id) + "/comments");
        list.replaceChildren(...data.comments.map((c) => commentItem(c, card)));
      } catch (err) {
        say("feed-status", err.message, "error");
        return;
      }
    }
    list.classList.remove("is-folded");
    box.dataset.expanded = "1";
    foldButton(card);
  }

  function toggleCommentForm(card, postId) {
    const box = card.querySelector(".comments");
    const btn = card.querySelector(".js-toggle");
    const open = box.querySelector("form");
    if (open) {
      open.remove();
      btn.setAttribute("aria-expanded", "false");
      box.hidden = !box.querySelector(".comment-list").children.length;
      return;
    }
    let list = box.querySelector(".comment-list");
    if (!list) {
      list = h("ol", { class: "comment-list is-folded" });
      box.prepend(list);
    }
    const form = commentForm(postId, list, card);
    box.append(form);
    box.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    // The + grows into the box: replayed each time it opens.
    box.classList.remove("is-opening");
    void box.offsetWidth;
    box.classList.add("is-opening");
    // On a phone, focusing would throw the keyboard up over the stickers.
    if (!matchMedia("(pointer: coarse)").matches) form.querySelector("textarea").focus();
  }

  function commentForm(postId, list, card) {
    let rid = null;
    const id = "cf-" + postId;
    const pill = on("pillComments");
    // Signed in, comments go under the account's name, so there's no name box.
    const account = PBAuth.user();
    const accountName = account && String(account.name || "").trim().length >= 2 ? String(account.name).trim() : "";
    const input = h("textarea", { id: id, rows: pill ? "1" : "2", maxlength: "1000", required: true, placeholder: pill ? "Add a comment…" : null });
    const name = h("input", { type: "text", maxlength: "32", autocomplete: "nickname", placeholder: pill ? "Name" : "Your name", "aria-label": "Your name", class: pill ? "pill-name" : null });
    name.value = savedName();
    const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
    const btn = pill
      ? h("button", { class: "pill-send", type: "submit", "aria-label": "Send", title: "Send" }, h("span", { "aria-hidden": "true" }, "↑"))
      : h("button", { class: "btn btn-small btn-primary", type: "submit" }, "SEND");
    input.addEventListener("input", () => { rid = null; });
    let form;
    if (pill) {
      // One line that grows with what's typed, up to a few lines.
      const grow = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 120) + "px"; };
      input.addEventListener("input", grow);
      // Enter sends; Shift+Enter is a new line.
      input.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); form.requestSubmit(); }
      });
      form = h("form", { class: "comment-form pill-form", novalidate: true },
        h("label", { class: "visually-hidden", for: id }, "Write a comment"),
        h("div", { class: "pill-row" }, accountName ? null : name, h("div", { class: "pill" }, input, btn)), status);
    } else {
      form = h("form", { class: "comment-form", novalidate: true },
        h("label", { class: "visually-hidden", for: id }, "Write a comment"),
        name, h("div", { class: "row" }, input, btn), status);
    }
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const body = input.value.trim();
      const who = accountName && pill ? accountName : name.value.trim();
      if (!body) { status.textContent = "Write something first."; input.focus(); return; }
      if (who.length < 2) { status.textContent = "Add your name."; name.focus(); return; }
      if (!rid) rid = requestId();
      btn.disabled = true;
      try {
        const res = await api("/api/cymbal/posts/" + encodeURIComponent(postId) + "/comments", {
          method: "POST", body: { body: body, name: who, request_id: rid },
        });
        rid = null;
        if (!(accountName && pill)) rememberName(who);
        if ($("name") && !$("name").value) $("name").value = who;
        input.value = "";
        input.style.height = "";
        status.textContent = "";
        if (!res.replayed) {
          const at = form.closest(".card") || card;
          const missing = on("openComments") && list.children.length < Number(at.dataset.count || 0);
          bumpCount(at, 1);
          if (missing) {
            // Some of the thread was never fetched: fetch it all, the new one included.
            list.classList.add("is-folded");
            await unfold(at);
          } else {
            list.append(commentItem(res.comment, at));
            if (on("openComments") && list.children.length > FOLD && list.classList.contains("is-folded")) await unfold(at);
          }
        }
      } catch (err) {
        if (err.status >= 400 && err.status < 500) rid = null;
        status.textContent = err.message;
        status.classList.add("is-error");
      } finally {
        btn.disabled = false;
      }
    });
    return form;
  }

  // ── stickers (everyone sees them; anyone signed in places them) ────────
  // Hand-drawn hearts and stars stuck anywhere on a post, one each per post. Pick one
  // up from the dock (or your own off its post) and it follows the mouse or finger; let
  // go over a post to stick it there, in place of the one you had on it. Dragging
  // works, and so does tap-then-tap. Letting go anywhere that isn't a post puts a new
  // sticker back, and takes a placed one off.

  // Every kind there is: the built-in two straight away, the owner's uploads once
  // /api/cymbal/sticker-kinds answers. The feed waits for that so none draws blank.
  let KINDS = [
    { id: "heart", label: "A red heart", src: "stickers/heart.png" },
    { id: "star", label: "A silver star", src: "stickers/star.png" },
  ];
  const kindOf = (id) => KINDS.find((k) => k.id === id);
  const stickerSrc = (kind) => { const k = kindOf(kind); return k && safeSrc(k.src) ? k.src : ""; };
  let carry = null;

  // Same-origin paths only: the built-in files and PocketBase's /api/files/.
  function safeSrc(src) {
    return typeof src === "string" && /^(stickers\/[a-z]+\.png|\/api\/files\/sticker_kinds\/[a-z0-9]{15}\/[A-Za-z0-9_.%-]+)$/.test(src);
  }

  async function loadKinds() {
    try {
      const data = await api("/api/cymbal/sticker-kinds");
      KINDS = data.kinds.filter((k) => safeSrc(k.src));
    } catch (_) { /* the built-in two still work */ }
  }

  function stickerImg(kind, cls) {
    const k = kindOf(kind);
    return h("img", { class: "sticker " + cls, src: stickerSrc(kind), alt: k ? k.label : "", draggable: "false" });
  }

  function pinSticker(el, s) {
    el.style.left = (s.x * 100) + "%";
    el.style.top = s.y + "px";
    el.style.setProperty("--rot", (s.rot || 0) + "deg");
  }

  function placedSticker(postId, s) {
    const el = stickerImg(s.kind, "sticker-placed");
    if (s.id) el.dataset.id = s.id;
    pinSticker(el, s);
    if (!s.mine) return el; // someone else's: look, don't touch
    el.classList.add("is-mine");
    el.addEventListener("pointerdown", (ev) => {
      if (carry || !el.dataset.id || ev.button > 0) return;
      ev.preventDefault();
      startCarry(s.kind, ev, { id: el.dataset.id, postId: postId, rot: s.rot || 0, el: el });
    });
    return el;
  }

  function stickerLayer(p) {
    return h("div", { class: "sticker-layer" }, p.stickers.filter((s) => kindOf(s.kind)).map((s) => placedSticker(p.id, s)));
  }

  // ── stickers in the comment box (stickerButton) ───────────────────────────
  // Signed in, + COMMENT opens the comment box with a row of every kind above it. Tap
  // one and it sticks on that post straight away; drag one and it goes wherever it's
  // let go. Picked up, it leaves its spot in the row empty until it's let go, as if
  // it had really been peeled off.

  function stickerTray(card, postId) {
    const tray = h("div", { class: "sticker-tray", role: "group", "aria-label": "Stick a sticker on this post" },
      KINDS.map((k) => h("button", {
        class: "sticker-pick", type: "button", title: k.label + ": tap to stick it here, or drag it",
        onpointerdown: (ev) => {
          if (carry || ev.button > 0) return;
          ev.preventDefault();
          const pick = ev.currentTarget;
          startCarry(k.id, ev, null);
          carry.home = card;
          carry.pick = pick;
          pick.classList.add("is-taken");
        },
        onclick: (ev) => {
          if (carry || ev.detail !== 0) return; // keyboard: stick it here
          stickHere(card, k.id);
        },
      }, h("img", { src: stickerSrc(k.id), alt: "", draggable: "false" }), h("span", { class: "visually-hidden" }, k.label))));
    // Each sticker sits at its own slight angle, different on every post but the same
    // each time the post is drawn (the feed refreshes, and they mustn't twitch).
    [...tray.children].forEach((b, i) => {
      let n = 0;
      for (const ch of postId + KINDS[i].id) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
      b.style.setProperty("--lean", (n % 21) - 10 + "deg");
    });
    return tray;
  }

  // The comment button shows the newest stickers (uploads come last in KINDS), so a
  // new one is visible on every post as soon as it's added.
  function stickStack() {
    const newest = KINDS.slice().reverse().slice(0, 3);
    return h("span", { class: "stick-stack", "aria-hidden": "true" }, newest.map((k) => h("img", { src: stickerSrc(k.id), alt: "" })));
  }

  // Somewhere near the top right of the post, a little different each time.
  function stickHere(card, kind) {
    const r = card.getBoundingClientRect();
    drop(r.left + r.width * (0.6 + Math.random() * 0.28), r.top + 36 + Math.random() * 40,
      { card: card, kind: kind, rot: Math.round(Math.random() * 24 - 12) });
  }

  function layerOf(card) {
    let layer = card.querySelector(".sticker-layer");
    if (!layer) {
      layer = h("div", { class: "sticker-layer" });
      card.append(layer);
    }
    return layer;
  }

  function cardAt(x, y) {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest("#posts .card[data-id]") : null;
  }

  function startCarry(kind, ev, from) {
    const el = stickerImg(kind, "sticker-carry");
    const rot = from ? from.rot : Math.round(Math.random() * 24 - 12);
    el.style.setProperty("--rot", rot + "deg");
    document.body.append(el);
    if (from) from.el.hidden = true;
    if (ev.target.releasePointerCapture && ev.target.hasPointerCapture && ev.target.hasPointerCapture(ev.pointerId)) {
      ev.target.releasePointerCapture(ev.pointerId);
    }
    carry = { kind: kind, el: el, from: from, rot: rot, x0: ev.clientX, y0: ev.clientY, moved: false, sticky: false, target: null, tilt: 0 };
    document.body.classList.add("is-sticking");
    follow(ev.clientX, ev.clientY);
    window.addEventListener("pointermove", onCarryMove, true);
    window.addEventListener("pointerdown", onCarryDown, true);
    window.addEventListener("pointerup", onCarryUp, true);
    window.addEventListener("pointercancel", cancelCarry, true);
    window.addEventListener("keydown", onCarryKey, true);
  }

  // The sticker in hand moves on the compositor (translate, not left/top), and leans a
  // little into the direction it's being moved, settling upright when it stops.
  function follow(x, y) {
    const el = carry.el;
    el.style.translate = "calc(" + x + "px - 50%) calc(" + y + "px - 50%)";
    if (carry.lastX !== undefined) {
      const lean = Math.max(-9, Math.min(9, (x - carry.lastX) * 0.7));
      carry.tilt = carry.tilt * 0.6 + lean * 0.4;
      el.style.setProperty("--tilt", carry.tilt.toFixed(2) + "deg");
      clearTimeout(carry.calm);
      carry.calm = setTimeout(() => {
        if (!carry || carry.el !== el) return;
        carry.tilt = 0;
        el.style.setProperty("--tilt", "0deg");
      }, 70);
    }
    carry.lastX = x;
    const card = cardAt(x, y);
    if (card !== carry.target) {
      if (carry.target) carry.target.classList.remove("sticker-target");
      if (card) card.classList.add("sticker-target");
      carry.target = card;
    }
  }

  function onCarryMove(ev) {
    if (!carry) return;
    if (Math.abs(ev.clientX - carry.x0) + Math.abs(ev.clientY - carry.y0) > 8) carry.moved = true;
    follow(ev.clientX, ev.clientY);
  }

  // Tap-then-tap: the second touch or click lands the sticker, so it mustn't also
  // press whatever is underneath.
  function onCarryDown(ev) {
    if (!carry) return;
    ev.preventDefault();
    ev.stopPropagation();
    follow(ev.clientX, ev.clientY);
  }

  function onCarryUp(ev) {
    if (!carry) return;
    if (!carry.moved && carry.home) {
      // A tap on a kind in a post's tray: it goes on that post.
      ev.preventDefault();
      ev.stopPropagation();
      swallowClick();
      const c = endCarry();
      stickHere(c.home, c.kind);
      return;
    }
    if (!carry.moved && !carry.sticky) {
      carry.sticky = true; // a tap on the button: keep holding it until the next one
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    swallowClick();
    drop(ev.clientX, ev.clientY);
  }

  function onCarryKey(ev) {
    if (ev.key === "Escape") { ev.preventDefault(); cancelCarry(); }
  }

  function swallowClick() {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    window.addEventListener("click", stop, { capture: true, once: true });
    setTimeout(() => window.removeEventListener("click", stop, true), 400);
  }

  function endCarry() {
    const c = carry;
    carry = null;
    clearTimeout(c.calm);
    window.removeEventListener("pointermove", onCarryMove, true);
    window.removeEventListener("pointerdown", onCarryDown, true);
    window.removeEventListener("pointerup", onCarryUp, true);
    window.removeEventListener("pointercancel", cancelCarry, true);
    window.removeEventListener("keydown", onCarryKey, true);
    document.body.classList.remove("is-sticking");
    if (c.target) c.target.classList.remove("sticker-target");
    if (c.pick) {
      // Back in its spot in the row, gently.
      const pick = c.pick;
      pick.classList.remove("is-taken");
      pick.classList.add("is-back");
      pick.addEventListener("animationend", () => pick.classList.remove("is-back"), { once: true });
    }
    c.el.remove();
    return c;
  }

  function cancelCarry() {
    if (!carry) return;
    const c = endCarry();
    if (c.from) c.from.el.hidden = false;
  }

  // Let go, a sticker peels down onto the post from however it was leaning, with no
  // rebound (app.css, sticker-peel).
  function settle(el, tilt) {
    el.classList.remove("is-new");
    el.style.setProperty("--tilt0", (tilt || 0).toFixed(2) + "deg");
    void el.offsetWidth;
    el.classList.add("is-new");
    el.addEventListener("animationend", () => el.classList.remove("is-new"), { once: true });
  }

  // `onto` places a sticker on a given post without one in hand (the tray's tap).
  async function drop(x, y, onto) {
    const c = onto || endCarry();
    const card = onto ? onto.card : cardAt(x, y);
    const from = onto ? null : c.from;
    try {
      if (!card) {
        if (!from) return;
        from.el.remove();
        await api("/api/cymbal/stickers/" + encodeURIComponent(from.id), { method: "DELETE" });
        return;
      }
      const r = card.getBoundingClientRect();
      const spot = {
        kind: c.kind,
        x: Math.min(1, Math.max(0, (x - r.left) / r.width)),
        y: Math.round(Math.min(5000, Math.max(0, y - r.top))),
        rot: c.rot,
      };
      const postId = card.dataset.id;
      if (from && from.postId === postId) {
        pinSticker(from.el, spot);
        from.el.hidden = false;
        settle(from.el, c.tilt);
        await api("/api/cymbal/stickers/" + encodeURIComponent(from.id) + "/move", { method: "POST", body: spot });
        return;
      }
      const layer = layerOf(card);
      const replaced = [...layer.querySelectorAll(".sticker-placed.is-mine")];
      replaced.forEach((old) => { old.hidden = true; });
      const el = placedSticker(postId, Object.assign({ mine: true }, spot));
      settle(el, c.tilt);
      layer.append(el);
      if (from) {
        from.el.remove();
        await api("/api/cymbal/stickers/" + encodeURIComponent(from.id), { method: "DELETE" });
      }
      try {
        const res = await api("/api/cymbal/posts/" + encodeURIComponent(postId) + "/stickers", { method: "POST", body: spot });
        el.dataset.id = res.sticker.id;
        replaced.forEach((old) => old.remove());
      } catch (err) {
        el.remove();
        replaced.forEach((old) => { old.hidden = false; });
        throw err;
      }
    } catch (err) {
      say("feed-status", "Sticker: " + err.message, "error");
    }
  }

  function stickerDock() {
    const dock = h("div", { id: "sticker-dock", class: "sticker-dock", role: "group", "aria-label": "Stickers" },
      KINDS.map((k) => k.id).map((kind) => h("button", {
        class: "btn sticker-pick", type: "button", title: kindOf(kind).label + ": pick it up, then let go on a post",
        onpointerdown: (ev) => {
          if (carry || ev.button > 0) return;
          ev.preventDefault();
          startCarry(kind, ev, null);
        },
        // Keyboard: Enter or Space picks it up at the button; Escape puts it back.
        onclick: (ev) => {
          if (carry || ev.detail !== 0) return;
          const r = ev.currentTarget.getBoundingClientRect();
          startCarry(kind, { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, target: ev.currentTarget }, null);
          carry.sticky = true;
        },
      }, h("img", { src: stickerSrc(kind), alt: "", draggable: "false" }), h("span", { class: "visually-hidden" }, kindOf(kind).label))));
    return dock;
  }

  function showStickerDock(on) {
    const dock = $("sticker-dock");
    if (on && !dock) document.body.append(stickerDock());
    if (!on) {
      cancelCarry();
      if (dock) dock.remove();
    }
  }

  // ── signing in ────────────────────────────────────────────────────────────
  // One form for everything: signing in ("in"), making an account ("up", with a name),
  // asking for a password reset link ("forgot", email only), and choosing a new
  // password from that link ("reset", password only; misc.html#reset=<token>).

  let mode = "in";
  let resetToken = "";
  const MODES = {
    in: { title: "SIGN IN", go: "SIGN IN", other: "New here? Make an account" },
    up: { title: "MAKE AN ACCOUNT", go: "MAKE ACCOUNT", other: "Have an account? Sign in" },
    forgot: { title: "RESET YOUR PASSWORD", go: "SEND LINK", other: "Remembered it? Sign in" },
    reset: { title: "CHOOSE A NEW PASSWORD", go: "SAVE PASSWORD", other: "Back to sign in" },
  };

  function loginMode(m) {
    mode = m;
    const show = (id, on) => { $(id).hidden = !on; document.querySelector('label[for="' + id + '"]').hidden = !on; };
    show("owner-name", m === "up");
    show("owner-email", m !== "reset");
    show("owner-password", m !== "forgot");
    document.querySelector('label[for="owner-password"]').textContent = m === "reset" ? "NEW PASSWORD" : "PASSWORD";
    $("owner-password").autocomplete = m === "in" ? "current-password" : "new-password";
    $("owner-login-title").textContent = MODES[m].title;
    $("owner-login-go").textContent = MODES[m].go;
    $("owner-login-mode").textContent = MODES[m].other;
    $("owner-login-forgot").hidden = m !== "in";
    say("owner-login-status", "");
  }

  function closeLogin() {
    $("owner-login").hidden = true;
    $("owner-password").value = "";
    loginMode("in");
  }

  $("owner-login-mode").addEventListener("click", () => {
    loginMode(mode === "in" ? "up" : "in");
    (mode === "up" ? $("owner-name") : $("owner-email")).focus();
  });

  $("owner-login-forgot").addEventListener("click", () => {
    loginMode("forgot");
    $("owner-email").focus();
  });

  // The top bar's account button: signed out it opens the sign-in form, signed in it
  // opens a small menu with SIGN OUT. On phones it's just the circle; wider screens
  // also show the name.
  function closeMenu() {
    $("account-menu").hidden = true;
    $("account").setAttribute("aria-expanded", "false");
  }

  function showAccount(user) {
    const name = user ? (user.name || String(user.email || "").split("@")[0] || "You") : "";
    const old = $("account-avatar");
    const circle = user ? avatar(name) : h("span", {}, "");
    circle.id = "account-avatar";
    circle.classList.add("account-avatar");
    if (!user) circle.classList.add("avatar", "avatar-out");
    old.replaceWith(circle);
    $("account-label").textContent = user ? name : "SIGN IN";
    const misc = $("misc-link");
    if (misc) misc.hidden = !on("miscPage");
    $("account").setAttribute("aria-label", user ? "Signed in as " + name : "Sign in");
    closeMenu();
    if (user && on("profilePics")) showAccountPic(user.id);
  }

  // Your own picture in the top bar, once the server says what it is.
  async function showAccountPic(id) {
    let pic = "";
    try { pic = (await api("/api/cymbal/me/profile")).pic; } catch (_) { return; }
    const u = PBAuth.user();
    if (!u || u.id !== id) return; // signed out or switched while it loaded
    const old = $("account-avatar");
    if (!safePic(pic)) {
      if (old.tagName === "IMG") showAccount(u); // the picture was just removed
      return;
    }
    const img = picAvatar(pic);
    img.id = "account-avatar";
    img.classList.add("account-avatar");
    old.replaceWith(img);
  }

  $("account").addEventListener("click", () => {
    if (PBAuth.isSignedIn()) {
      const open = $("account-menu").hidden;
      $("account-menu").hidden = !open;
      $("account").setAttribute("aria-expanded", String(open));
      return;
    }
    const form = $("owner-login");
    if (!form.hidden) return closeLogin();
    form.hidden = false;
    form.scrollIntoView({ block: "nearest" });
    $("owner-email").focus();
  });

  document.addEventListener("click", (ev) => {
    if (!ev.target.closest(".account")) closeMenu();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("account-menu").hidden) { closeMenu(); $("account").focus(); }
  });

  $("owner-login-cancel").addEventListener("click", closeLogin);

  $("owner-login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = $("owner-email").value.trim();
    const password = $("owner-password").value;
    const name = $("owner-name").value.trim();
    const m = mode;
    if (m === "up" && name.length < 2) return say("owner-login-status", "Pick a name of at least 2 characters.", "error");
    if (m === "forgot" && !email) return say("owner-login-status", "Enter the email you signed up with.", "error");
    if ((m === "in" || m === "up") && (!email || !password)) return say("owner-login-status", "Enter your email and password.", "error");
    if ((m === "up" || m === "reset") && password.length < 8) return say("owner-login-status", "Use a password of at least 8 characters.", "error");
    const btn = $("owner-login-go");
    btn.disabled = true;
    say("owner-login-status", { in: "Signing in…", up: "Making your account…", forgot: "Sending…", reset: "Saving…" }[m]);
    try {
      if (m === "up") await PBAuth.signUp(email, password, name);
      else if (m === "in") await PBAuth.signIn(email, password);
      else if (m === "forgot") {
        await PBAuth.requestReset(email);
        say("owner-login-status", "If there's an account for " + email.toLowerCase() + ", a link to choose a new password is on its way. Check your email.", "ok");
        return;
      } else {
        await PBAuth.confirmReset(resetToken, password);
        resetToken = "";
        $("owner-password").value = "";
        loginMode("in");
        say("owner-login-status", "Password changed. Sign in with it now.", "ok");
        $("owner-email").focus();
        return;
      }
      closeLogin();
    } catch (err) {
      const status = err && err.status;
      const msg = err && err.response && err.response.message;
      say("owner-login-status", status === 0 ? "Couldn't reach Cymbal. Check your connection."
        : status === 429 ? (m === "up" && msg ? msg : "Too many attempts. Wait a minute and try again.")
        : m === "up" ? (msg || "That account couldn't be made.")
        : m === "forgot" ? "That didn't send. Try again in a couple of minutes."
        : m === "reset" ? "That link has expired or was already used. Ask for a new one."
        : "That email and password didn't match.", "error");
    } finally {
      btn.disabled = false;
    }
  });

  // Arriving from the reset email: misc.html#reset=<token>. The token leaves the address
  // bar straight away so it isn't left in history or shared by accident.
  function openReset() {
    const m = /^#reset=([A-Za-z0-9._-]+)$/.exec(location.hash);
    if (!m) return;
    resetToken = m[1];
    history.replaceState(null, "", location.pathname + location.search);
    loginMode("reset");
    $("owner-login").hidden = false;
    $("owner-login").scrollIntoView({ block: "nearest" });
  }
  openReset();
  window.addEventListener("hashchange", openReset);

  $("signout").addEventListener("click", () => PBAuth.signOut());

  const REASONS = {
    waiting_for_source: "waiting for track details",
    waiting_for_spotify: "waiting for Spotify",
    waiting_for_playlist: "waiting for the playlist",
    not_configured: "provider not configured",
    reconnect: "needs reconnecting",
    rate_limited: "rate-limited",
    quota: "out of quota today",
    retrying: "retrying",
    verifying: "checking an interrupted write",
  };

  async function loadOwner() {
    const box = $("owner");
    box.hidden = false;
    let s;
    try {
      s = await api("/api/cymbal/owner/status");
    } catch (err) {
      box.replaceChildren(h("p", { class: "status is-error" }, "Owner panel: " + err.message));
      return;
    }
    const status = h("p", { id: "owner-status", class: "status", role: "status", "aria-live": "polite" });
    const review = h("div", { id: "owner-review" });
    const attention = h("div", { id: "owner-attention" });
    const dismissed = h("div", { id: "owner-dismissed" });
    let open = false;
    // Folded away on the feed until opened; on the misc page it's the point, so open.
    try {
      const saved = sessionStorage.getItem("cymbal_owner_open");
      open = PAGE === "misc" ? saved !== "0" : saved === "1";
    } catch (_) { open = PAGE === "misc"; }
    const details = h("details", { open: open ? true : null },
      h("summary", { id: "owner-title" }, "OWNER PANEL"),
      h("div", { class: "owner-grid" },
        s.providers.map((p) => providerCard(p)),
        h("div", { class: "row" },
          h("button", { class: "btn btn-small", type: "button", onclick: runNow }, "SYNC NOW"),
          h("button", { class: "btn btn-small", type: "button", onclick: loadOwner }, "REFRESH")),
        s.spotify_transfer_allowed ? null :
          h("p", { class: "small" }, "Matching Spotify-posted songs to Apple Music and YouTube is off. Set CYMBAL_SPOTIFY_METADATA_TRANSFER=allowed once you've confirmed Spotify's terms permit it."),
        h("p", { class: "small" }, "Callback URLs: ", h("code", null, s.redirect_uris.spotify), " and ", h("code", null, s.redirect_uris.youtube)),
        status,
        review,
        attention,
        dismissed));
    details.addEventListener("toggle", () => {
      try { sessionStorage.setItem("cymbal_owner_open", details.open ? "1" : "0"); } catch (_) { /* ignore */ }
    });
    box.replaceChildren(details);
    loadReview();
    loadAttention();
    loadDismissed();
    const apple = s.providers.find((p) => p.provider === "apple_music");
    if (apple && apple.configured) appleAutoStart();
  }

  function countsLine(p) {
    const c = p.counts || {};
    const bits = [];
    if (c.pending) bits.push(c.pending + " waiting");
    if (c.pending_device) bits.push(c.pending_device + " waiting for this browser");
    if (c.attention) bits.push(c.attention + " need a look");
    if (c.review) bits.push(c.review + " guessed, to check");
    bits.push((c.synced || 0) + " added");
    return bits.join(", ");
  }

  function providerCard(p) {
    const actions = [];
    let state;
    if (!p.configured) {
      state = h("span", { class: "bad" }, "Not configured on the server");
    } else if (p.provider === "apple_music") {
      state = p.has_playlist ? h("span", { class: "good" }, "Playlist ready") : h("span", null, "No playlist yet");
      actions.push(h("button", { class: "btn btn-small", type: "button", onclick: appleConnect }, "AUTHORISE IN THIS BROWSER"));
    } else if (p.status === "needs_reauth") {
      state = h("span", { class: "bad" }, "Authorisation expired");
      actions.push(h("button", { class: "btn btn-small btn-primary", type: "button", onclick: () => connect(p.provider) }, "RECONNECT"));
    } else if (p.status !== "connected") {
      state = h("span", null, "Not connected");
      actions.push(h("button", { class: "btn btn-small btn-primary", type: "button", onclick: () => connect(p.provider) }, "CONNECT"));
    } else {
      state = h("span", { class: "good" }, "Connected" + (p.account ? " as " + p.account : ""));
      if (!p.has_playlist) actions.push(h("button", { class: "btn btn-small btn-primary", type: "button", onclick: () => createPlaylist(p.provider) }, "CREATE PLAYLIST"));
      actions.push(h("button", { class: "btn btn-small btn-quiet", type: "button", onclick: () => disconnect(p.provider) }, "DISCONNECT"));
    }
    return h("div", { class: "prov" },
      h("h3", null, p.label.toUpperCase()),
      h("p", null, state),
      p.playlist_url ? h("p", { class: "small" }, extLink(p.playlist_url, "Open the playlist")) : null,
      p.cooldown_until ? h("p", { class: "bad" }, "Paused until " + clock(p.cooldown_until)) : null,
      h("p", { class: "small" }, countsLine(p)),
      p.quota ? h("p", { class: "small" }, "YouTube today: " + p.quota.units + "/" + p.quota.unit_budget + " units, " +
        p.quota.searches + "/" + p.quota.search_budget + " searches") : null,
      p.last_error ? h("p", { class: "small" }, "Last problem: " + p.last_error) : null,
      p.provider === "apple_music" ? h("div", { id: "apple-extra" }) : null,
      actions.length ? h("div", { class: "row" }, actions) : null);
  }

  function ownerSay(text, kind) { say("owner-status", text, kind); }

  async function connect(provider) {
    try {
      const res = await api("/api/cymbal/owner/oauth/" + provider + "/start", { method: "POST" });
      if (safeHref(res.url)) location.assign(res.url);
    } catch (err) { ownerSay(err.message, "error"); }
  }

  async function createPlaylist(provider) {
    ownerSay("Creating the " + LABELS[provider] + " playlist…");
    try {
      await api("/api/cymbal/owner/providers/" + provider + "/playlist", { method: "POST" });
      ownerSay(LABELS[provider] + " playlist ready.", "ok");
      loadOwner();
    } catch (err) { ownerSay(err.message, "error"); }
  }

  async function disconnect(provider) {
    if (!confirm("Disconnect " + LABELS[provider] + "? New songs will wait until you reconnect.")) return;
    try {
      await api("/api/cymbal/owner/providers/" + provider + "/disconnect", { method: "POST" });
      loadOwner();
    } catch (err) { ownerSay(err.message, "error"); }
  }

  async function runNow() {
    ownerSay("Syncing…");
    try {
      const r = await api("/api/cymbal/owner/sync/run", { method: "POST" });
      ownerSay(r.skipped ? "A sync is already running." : "Processed " + r.jobs + " job(s), looked up " + r.metadata + " track(s).", "ok");
      loadOwner();
      refreshTop();
    } catch (err) { ownerSay(err.message, "error"); }
  }

  async function loadAttention() {
    const box = $("owner-attention");
    if (!box) return;
    let data;
    try { data = await api("/api/cymbal/owner/syncs?status=attention"); } catch (err) { box.replaceChildren(); return; }
    if (!data.syncs.length) {
      box.replaceChildren(h("p", { class: "small" }, "Nothing needs a look."));
      return;
    }
    box.replaceChildren(h("h3", { class: "label" }, "NEEDS A LOOK"), h("ul", { class: "attn" }, data.syncs.map(attentionItem)));
  }

  const mmss = (ms) => { const t = Math.round(ms / 1000); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };

  // Best guesses the worker added without an exact match. Each one stays here until
  // the owner says it's right or names the right item.
  async function loadReview() {
    const box = $("owner-review");
    if (!box) return;
    let data;
    try { data = await api("/api/cymbal/owner/syncs?status=review"); } catch (err) { box.replaceChildren(); return; }
    if (!data.syncs.length) { box.replaceChildren(); return; }
    box.replaceChildren(h("h3", { class: "label" }, "GUESSED, TO CHECK"), h("ul", { class: "attn" }, data.syncs.map(reviewItem)));
  }

  function reviewItem(r) {
    const g = r.guess || { confidence: "unsure", notes: [] };
    const p = r.picked;
    const input = h("input", { type: "url", inputmode: "url", placeholder: "Right " + r.target_label + " link", "aria-label": "The right " + r.target_label + " link for this song" });
    const form = h("form", { novalidate: true }, input, h("button", { class: "btn btn-small", type: "submit" }, "REPLACE"));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        const res = await api("/api/cymbal/owner/syncs/" + r.id + "/override", { method: "POST", body: { url: input.value.trim() } });
        ownerSay(res.remove_url
          ? "Saved; the right one is added on the next sync. Remove the wrong one from the " + r.target_label + " playlist yourself."
          : "Saved. It'll be added on the next sync.", "ok");
        loadReview();
      } catch (err) { ownerSay(err.message, "error"); }
    });
    return h("li", null,
      h("strong", null, (r.post ? (r.post.title || "Untitled") + (r.post.artist ? " by " + r.post.artist : "") : "Removed post") + " to " + r.target_label),
      h("span", null, h("span", { class: "guess-tag is-" + g.confidence }, g.confidence === "likely" ? "LIKELY" : "UNSURE"), " Guessed: ",
        r.target_url ? extLink(r.target_url, p ? p.title : "the guess") : (p ? p.title : "the guess"),
        p && p.artists.length ? " by " + p.artists.join(", ") : "",
        p && p.duration_ms ? " (" + mmss(p.duration_ms) + (r.want_duration_ms ? " vs " + mmss(r.want_duration_ms) : "") + ")" : ""),
      g.notes.length ? h("span", { class: "small" }, "Differs on " + g.notes.join("; ")) : null,
      r.post ? h("span", { class: "small" }, extLink(r.post.url, "original link")) : null,
      h("div", { class: "row" }, h("button", { class: "btn btn-small btn-primary", type: "button", onclick: async () => {
        try {
          await api("/api/cymbal/owner/syncs/" + r.id + "/confirm", { method: "POST" });
          ownerSay("Marked as right.", "ok");
          loadReview();
        } catch (err) { ownerSay(err.message, "error"); }
      } }, "LOOKS RIGHT"), dismissButton(r, loadReview)),
      form);
  }

  // The song probably isn't on that service at all: stop asking about it.
  function dismissButton(r, reload) {
    return h("button", { class: "btn btn-small btn-quiet", type: "button", onclick: async () => {
      if (!confirm("Dismiss this? It won't be added to " + r.target_label + " unless you retry it.")) return;
      try {
        const res = await api("/api/cymbal/owner/syncs/" + r.id + "/dismiss", { method: "POST" });
        ownerSay(res.remove_url
          ? "Dismissed. Remove the guess from the " + r.target_label + " playlist yourself."
          : "Dismissed.", "ok");
        reload();
        loadDismissed();
      } catch (err) { ownerSay(err.message, "error"); }
    } }, "NOT ON " + r.target_label.toUpperCase());
  }

  // Songs the owner said aren't on a service, folded away, each one a RETRY from back.
  async function loadDismissed() {
    const box = $("owner-dismissed");
    if (!box) return;
    let data;
    try { data = await api("/api/cymbal/owner/syncs?status=dismissed"); } catch (err) { box.replaceChildren(); return; }
    if (!data.syncs.length) { box.replaceChildren(); return; }
    box.replaceChildren(h("details", null,
      h("summary", { class: "label" }, "DISMISSED (" + data.syncs.length + ")"),
      h("ul", { class: "attn" }, data.syncs.map((r) => h("li", null,
        h("strong", null, (r.post ? (r.post.title || "Untitled") + (r.post.artist ? " by " + r.post.artist : "") : "Removed post") + " to " + r.target_label),
        h("div", { class: "row" }, h("button", { class: "btn btn-small", type: "button", onclick: async () => {
          try {
            await api("/api/cymbal/owner/syncs/" + r.id + "/retry", { method: "POST" });
            ownerSay("Queued again.", "ok");
            loadDismissed();
          } catch (err) { ownerSay(err.message, "error"); }
        } }, "RETRY")))))));
  }

  // Take a candidate the worker found but wouldn't add on its own.
  function pickButton(r, candidateId, label) {
    return h("button", { class: "btn btn-small", type: "button", onclick: async () => {
      try {
        await api("/api/cymbal/owner/syncs/" + r.id + "/pick", { method: "POST", body: candidateId ? { candidate_id: candidateId } : {} });
        ownerSay("Picked. It'll be added on the next sync.", "ok");
        loadAttention();
      } catch (err) { ownerSay(err.message, "error"); }
    } }, label);
  }

  function candidateLine(r, c) {
    return c.title + (c.artists.length ? " by " + c.artists.join(", ") : "") +
      (c.duration_ms ? " (" + mmss(c.duration_ms) + (r.want_duration_ms ? " vs " + mmss(r.want_duration_ms) : "") + ")" : "");
  }

  function attentionItem(r) {
    const input = h("input", { type: "url", inputmode: "url", placeholder: "Exact " + r.target_label + " link", "aria-label": "Exact " + r.target_label + " link for this song" });
    const form = h("form", { novalidate: true }, input, h("button", { class: "btn btn-small btn-primary", type: "submit" }, "USE LINK"));
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        await api("/api/cymbal/owner/syncs/" + r.id + "/override", { method: "POST", body: { url: input.value.trim() } });
        ownerSay("Saved. It'll be added on the next sync.", "ok");
        loadAttention();
      } catch (err) { ownerSay(err.message, "error"); }
    });
    const steps = Object.keys(r.steps || {}).map((k) => k + ": " + r.steps[k]).join(", ");
    // The best of what the search found, below the bar for a guess: one tap to take it.
    const c = r.closest;
    const top = c ? h("div", { class: "row" },
      h("span", null, h("span", { class: "guess-tag is-unsure" }, "CLOSEST"), " ",
        extLink(c.url, c.title),
        candidateLine(r, c).slice(c.title.length),
        c.notes.length ? h("span", { class: "small" }, " Differs on " + c.notes.join("; ")) : null),
      pickButton(r, c.id, "USE THIS")) : null;
    const near = (r.near_misses || []).filter((n) => !c || n.id !== c.id).map((n) => h("div", { class: "row" },
      h("span", { class: "small" }, (c ? "Also found: " : "Found: ") + candidateLine(r, n) + ", differs on " + n.reasons.join(", ")),
      !c && n.id ? pickButton(r, n.id, "USE THIS") : null));
    const searched = r.reason === "no_match" && steps && !(r.near_misses || []).length && !c
      ? h("span", { class: "small" }, "The search found nothing to compare against.") : null;
    return h("li", null,
      h("strong", null, (r.post ? (r.post.title || "Untitled") + (r.post.artist ? " by " + r.post.artist : "") : "Removed post") + " to " + r.target_label),
      r.post ? h("span", { class: "small" }, extLink(r.post.url, "original link")) : null,
      h("span", null, r.detail || REASONS[r.reason] || r.reason),
      steps ? h("span", { class: "small" }, "Tried " + steps) : null,
      top,
      ...near,
      searched,
      form,
      h("div", { class: "row" }, h("button", { class: "btn btn-small", type: "button", onclick: async () => {
        try {
          await api("/api/cymbal/owner/syncs/" + r.id + "/retry", { method: "POST" });
          ownerSay("Queued again.", "ok");
          loadAttention();
        } catch (err) { ownerSay(err.message, "error"); }
      } }, "RETRY"), dismissButton(r, loadAttention)));
  }

  // ── Apple Music, in the owner's browser ───────────────────────────────────
  // Apple's Music User Token is tied to this app and this device, and it stays here:
  // MusicKit keeps it, and Cymbal's server never receives it. So Apple additions wait
  // until the owner opens Cymbal in an authorised browser, and then drain by themselves.

  let music = null;
  let appleCfg = null;
  let draining = false;

  function loadMusicKit() {
    return new Promise((resolve, reject) => {
      if (window.MusicKit) return resolve(window.MusicKit);
      document.addEventListener("musickitloaded", () => resolve(window.MusicKit), { once: true });
      const s = document.createElement("script");
      s.src = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
      s.async = true;
      s.setAttribute("data-web-components", "");
      s.onerror = () => reject(new Error("Couldn't load Apple's MusicKit."));
      document.head.append(s);
    });
  }

  async function appleSetup(interactive) {
    appleCfg = await api("/api/cymbal/owner/apple/config");
    if (!appleCfg.configured) throw new Error("Apple Music isn't configured on the server yet.");
    const MK = await loadMusicKit();
    if (!music) {
      await MK.configure({
        developerToken: appleCfg.developer_token,
        app: { name: "Cymbal on Website", build: "1.0.0" },
        storefrontId: appleCfg.storefront,
      });
      music = MK.getInstance();
    }
    if (!music.isAuthorized && interactive) await music.authorize();
    if (music.isAuthorized) store.set("cymbal_apple_authorised", "1");
    return music.isAuthorized;
  }

  async function am(path, opts) {
    const o = opts || {};
    const options = o.method ? { fetchOptions: { method: o.method, body: o.body ? JSON.stringify(o.body) : undefined } } : undefined;
    const res = await music.api.music(path, o.query || {}, options);
    return res && res.data;
  }

  function appleExtra(nodes) {
    const box = $("apple-extra");
    if (box) box.replaceChildren(...nodes);
  }

  async function appleConnect() {
    ownerSay("Opening Apple Music…");
    try {
      const ok = await appleSetup(true);
      if (!ok) { ownerSay("Apple Music wasn't authorised.", "error"); return; }
      ownerSay("Apple Music authorised in this browser.", "ok");
      await appleAfterAuth();
    } catch (err) {
      ownerSay(err.message || "Apple Music authorisation failed.", "error");
    }
  }

  // Only load Apple's script automatically on a browser that has been authorised
  // before; anywhere else it waits for the button.
  async function appleAutoStart() {
    if (store.get("cymbal_apple_authorised") !== "1") return;
    try {
      if (await appleSetup(false)) await appleAfterAuth();
    } catch (_) { /* the button remains */ }
  }

  async function appleAfterAuth() {
    const extra = [h("p", { class: "good" }, "Authorised in this browser")];
    if (!appleCfg.playlist_id) {
      extra.push(h("button", { class: "btn btn-small btn-primary", type: "button", onclick: appleCreatePlaylist }, "CREATE APPLE PLAYLIST"));
    } else {
      extra.push(h("button", { class: "btn btn-small", type: "button", onclick: () => drainApple(true) }, "ADD WAITING SONGS NOW"));
      if (!appleCfg.playlist_url) {
        const input = h("input", { type: "url", inputmode: "url", placeholder: "music.apple.com playlist share link", "aria-label": "Apple Music playlist share link" });
        const form = h("form", { class: "row", novalidate: true }, input, h("button", { class: "btn btn-small", type: "submit" }, "SAVE LINK"));
        form.addEventListener("submit", async (ev) => {
          ev.preventDefault();
          try {
            await api("/api/cymbal/owner/apple/share-url", { method: "POST", body: { url: input.value.trim() } });
            ownerSay("Share link saved.", "ok");
          } catch (err) { ownerSay(err.message, "error"); }
        });
        extra.push(h("p", { class: "small" }, "Apple shows the public link once the playlist has synced. Cymbal tries to find it itself; paste it here if it doesn't."), form);
        appleDiscoverShare();
      }
    }
    appleExtra(extra);
    if (appleCfg.playlist_id) {
      drainApple(false);
      clearInterval(appleTimer);
      appleTimer = setInterval(() => { if (!document.hidden) drainApple(false); }, 5 * 60 * 1000);
    }
  }

  async function appleCreatePlaylist() {
    ownerSay("Creating the Apple Music playlist…");
    try {
      const res = await am("/v1/me/library/playlists", {
        method: "POST",
        body: { attributes: { name: "Cymbal on Website", description: "Songs friends posted on cymbal-on-website.solhann.net.", isPublic: true } },
      });
      const id = res && res.data && res.data[0] && res.data[0].id;
      if (!id) throw new Error("Apple didn't return a playlist id.");
      await api("/api/cymbal/owner/apple/playlist", { method: "POST", body: { library_id: id } });
      appleCfg.playlist_id = id;
      ownerSay("Apple Music playlist created.", "ok");
      await appleAfterAuth();
    } catch (err) { ownerSay(err.message || "Couldn't create the Apple Music playlist.", "error"); }
  }

  async function appleDiscoverShare() {
    try {
      const res = await am("/v1/me/library/playlists/" + encodeURIComponent(appleCfg.playlist_id));
      const pp = res && res.data && res.data[0] && res.data[0].attributes && res.data[0].attributes.playParams;
      if (pp && pp.globalId) {
        const url = "https://music.apple.com/" + appleCfg.storefront + "/playlist/cymbal-on-website/" + pp.globalId;
        await api("/api/cymbal/owner/apple/share-url", { method: "POST", body: { url: url } });
        appleCfg.playlist_url = url;
      }
    } catch (_) { /* Apple hasn't published it yet; the paste box stays */ }
  }

  // Catalogue ids already in the library playlist. An empty playlist answers 404.
  async function appleCatalogIds(playlistId) {
    const ids = new Set();
    for (let offset = 0; offset < 2000; offset += 100) {
      let res;
      try {
        res = await am("/v1/me/library/playlists/" + encodeURIComponent(playlistId) + "/tracks", { query: { limit: 100, offset: offset } });
      } catch (err) {
        break;
      }
      const data = (res && res.data) || [];
      data.forEach((t) => {
        const c = t && t.attributes && t.attributes.playParams && t.attributes.playParams.catalogId;
        if (c) ids.add(String(c));
      });
      if (!res || !res.next || data.length < 100) break;
    }
    return ids;
  }

  async function drainApple(loud) {
    if (draining || !music || !music.isAuthorized || !appleCfg || !appleCfg.playlist_id) return;
    draining = true;
    let added = 0;
    let failed = 0;
    try {
      let present = null;
      for (let round = 0; round < 5; round++) {
        const claim = await api("/api/cymbal/owner/apple/claim", { method: "POST", body: { max: 25 } });
        if (!claim.items.length) break;
        if (!present) present = await appleCatalogIds(claim.playlist_id);
        const results = [];
        for (const it of claim.items) {
          if (present.has(it.catalog_id)) {
            results.push({ sync_id: it.sync_id, lease: it.lease, outcome: "present" });
            continue;
          }
          try {
            await am("/v1/me/library/playlists/" + encodeURIComponent(claim.playlist_id) + "/tracks", {
              method: "POST", body: { data: [{ id: it.catalog_id, type: "songs" }] },
            });
            present.add(it.catalog_id);
            added++;
            results.push({ sync_id: it.sync_id, lease: it.lease, outcome: "added" });
          } catch (err) {
            failed++;
            results.push({ sync_id: it.sync_id, lease: it.lease, outcome: "failed", error: String((err && (err.message || err.errorCode)) || "error").slice(0, 200) });
          }
        }
        await api("/api/cymbal/owner/apple/complete", { method: "POST", body: { results: results } });
      }
      if (added || failed || loud) {
        ownerSay("Apple Music: added " + added + (failed ? ", " + failed + " failed (will retry)" : "") + ".", failed ? "error" : "ok");
      }
      if (added) refreshTop();
    } catch (err) {
      if (loud) ownerSay(err.message || "Apple Music sync failed.", "error");
    } finally {
      draining = false;
    }
  }

  function stopApple() {
    clearInterval(appleTimer);
    appleTimer = null;
  }

  // ── playlists (under the composer) ────────────────────────────────────────
  // One button per service. One that isn't set up yet shows greyed out, so the row
  // always reads Spotify, Apple Music, YouTube in the same order.
  async function loadPlaylists() {
    let data;
    try { data = await api("/api/cymbal/playlists"); } catch (err) { return; }
    $("playlist-btns").replaceChildren(...data.playlists.map((p) => {
      const kids = [h("span", { class: "pl-dot", "aria-hidden": "true" }), p.label];
      const cls = "btn btn-small pl-btn pl-" + String(p.provider).replace(/[^a-z_]/g, "");
      const href = safeHref(p.url);
      if (!href) return h("span", { class: cls + " is-waiting", title: p.label + " playlist isn't set up yet" }, kids);
      return h("a", { class: cls, href: href, target: "_blank", rel: "noopener noreferrer" }, kids);
    }));
    $("playlists").hidden = false;
  }

  // ── listens ───────────────────────────────────────────────────────────────
  // A player is another site's page in an iframe, so the page can't see clicks in it.
  // What it can see is focus moving into one: the window blurs and the iframe becomes
  // the active element. That, or opening the song's own link, counts as a listen,
  // once per post per page; the server counts each browser once per post.
  // Counted for everyone whoever can see the count (features.js listenCount).

  const listened = new Set();

  async function heard(card) {
    const id = card && card.dataset.id;
    if (!id || listened.has(id)) return;
    listened.add(id);
    try {
      const res = await api("/api/cymbal/posts/" + encodeURIComponent(id) + "/listen", { method: "POST", body: {} });
      const n = card.querySelector(".js-listens");
      if (res.counted && n) {
        const next = Number(n.textContent || 0) + 1;
        n.textContent = String(next);
        n.nextSibling.textContent = next === 1 ? " listen" : " listens";
      }
    } catch (_) {
      listened.delete(id);
    }
  }

  function checkPlayerFocus() {
    const el = document.activeElement;
    if (el && el.tagName === "IFRAME") heard(el.closest("#posts .card[data-id]"));
  }

  if (onFeed) {
    window.addEventListener("blur", () => setTimeout(checkPlayerFocus, 0));
    // From one player straight to another the window doesn't blur again.
    setInterval(() => { if (!document.hasFocus()) checkPlayerFocus(); }, 1000);
    $("posts").addEventListener("click", (ev) => {
      if (ev.target.closest(".track a")) heard(ev.target.closest(".card[data-id]"));
    });
  }

  // ── misc page: your picture, most reacts, and stickers people submit ──────

  // A picture straight from a phone is often several megabytes, so it's cropped to a
  // centred square and shrunk to 256px here before it's sent. Read as a data: URL,
  // which the page's CSP allows for images where blob: is not.
  function squarePicture(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Couldn't read that picture."));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("That doesn't look like a picture."));
        img.onload = () => {
          const side = Math.min(img.naturalWidth, img.naturalHeight);
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 256;
          canvas.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't shrink that picture."))), "image/jpeg", 0.88);
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Signed in only: the picture belongs to the account.
  async function loadProfile() {
    const box = $("profile");
    if (!box) return;
    if (!memberNow) { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    let pic = "";
    try { pic = (await api("/api/cymbal/me/profile")).pic; } catch (_) { /* shown as none */ }
    const status = h("p", { id: "profile-status", class: "status", role: "status", "aria-live": "polite" });
    const face = safePic(pic) ? picAvatar(pic) : h("span", { class: "avatar avatar-none", "aria-hidden": "true" });
    face.classList.add("profile-face");
    const file = h("input", { id: "profile-file", class: "visually-hidden", type: "file", accept: "image/*" });
    file.addEventListener("change", async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      say("profile-status", "Uploading…");
      try {
        const body = new FormData();
        body.append("image", await squarePicture(f), "me.jpg");
        await api("/api/cymbal/me/profile", { method: "POST", body: body });
        await loadProfile();
        if (PBAuth.user()) showAccountPic(PBAuth.user().id);
        say("profile-status", "Saved. Your posts show it now.", "ok");
      } catch (err) {
        say("profile-status", err.message, "error");
      }
    });
    // One name for the account: posts, comments and the top bar all use it.
    const account = PBAuth.user();
    const name = h("input", { id: "profile-name", type: "text", maxlength: "32", autocomplete: "nickname", placeholder: "Your name" });
    name.value = (account && account.name) || savedName();
    name.addEventListener("change", async () => {
      const v = name.value.trim().replace(/\s+/g, " ");
      const u = PBAuth.user();
      if (v.length < 2) { say("profile-status", "Pick a name of at least 2 characters.", "error"); return; }
      rememberName(v);
      if (!u || u.name === v) { say("profile-status", "Name saved.", "ok"); return; }
      try {
        // The record comes back with the new name; saving it updates the top bar.
        const rec = await pb.collection("users").update(u.id, { name: v });
        pb.authStore.save(pb.authStore.token, rec);
        say("profile-status", "Name saved.", "ok");
      } catch (err) {
        say("profile-status", "Couldn't save your name. Try again.", "error");
      }
    });
    box.replaceChildren(h("h2", { id: "profile-title", class: "label" }, "YOU"),
      h("div", { class: "profile-row" }, face,
        h("div", { class: "profile-fields" },
          h("label", { class: "visually-hidden", for: "profile-name" }, "Your name"), name,
          h("div", { class: "row" },
            h("label", { class: "btn btn-small", for: "profile-file" }, safePic(pic) ? "CHANGE PICTURE" : "ADD A PICTURE"), file,
            safePic(pic) ? h("button", { class: "link-btn", type: "button", onclick: async () => {
              try {
                await api("/api/cymbal/me/profile", { method: "DELETE" });
                await loadProfile();
                if (PBAuth.user()) showAccountPic(PBAuth.user().id);
                say("profile-status", "Picture removed.", "ok");
              } catch (err) { say("profile-status", err.message, "error"); }
            } }, "remove") : null))),
      status);
  }

  async function loadLeaderboard() {
    const box = $("leaderboard");
    if (!box) return;
    box.hidden = false;
    let data;
    try { data = await api("/api/cymbal/leaderboard"); } catch (err) {
      box.replaceChildren(h("h2", { class: "label" }, "MOST REACTS"), h("p", { class: "status is-error" }, err.message));
      return;
    }
    const rows = data.posts.slice(0, 3).map((p, i) => h("li", { class: "board-row" },
      h("span", { class: "board-rank" }, String(i + 1)),
      h("span", { class: "board-song" },
        h("strong", null, extLink(p.url, p.title || "Untitled")),
        h("span", { class: "small" }, (p.artist ? p.artist + " · " : "") + "posted by " + p.poster + " · " + when(p.created))),
      h("span", { class: "board-reacts", title: p.reacts + (p.reacts === 1 ? " react" : " reacts") },
        Object.keys(p.kinds).filter((k) => kindOf(k)).map((k) => h("span", { class: "board-kind" },
          h("img", { src: stickerSrc(k), alt: kindOf(k).label }), p.kinds[k] > 1 ? "×" + p.kinds[k] : null)),
        h("span", { class: "board-n" }, String(p.reacts))),
      h("span", { class: "small board-extra" }, "♪ " + p.listens + " · " + p.comments + (p.comments === 1 ? " comment" : " comments"))));
    box.replaceChildren(h("h2", { class: "label" }, "MOST REACTS"),
      rows.length ? h("ol", { class: "board" }, rows) : h("p", { class: "small" }, "No reacts yet. Stick something on a post."));
  }

  // Anyone signed in submits a few; only the owner removes one.
  async function loadStickerAdmin() {
    const box = $("sticker-admin");
    if (!box) return;
    if (!memberNow) { box.hidden = true; box.replaceChildren(); return; }
    box.hidden = false;
    await loadKinds();
    const status = h("p", { id: "sticker-status", class: "status", role: "status", "aria-live": "polite" });
    const label = h("input", { id: "sticker-label", type: "text", maxlength: "32", placeholder: "Sticker name, e.g. A blue moon", required: true });
    const file = h("input", { id: "sticker-file", type: "file", accept: "image/png", required: true });
    const go = h("button", { class: "btn btn-small btn-primary", type: "submit" }, "UPLOAD");
    const form = h("form", { class: "sticker-upload", novalidate: true },
      h("label", { class: "visually-hidden", for: "sticker-label" }, "Sticker name"), label,
      h("label", { class: "label", for: "sticker-file" }, "PNG ", h("span", { class: "label-note" }, "up to 1 MB; a transparent background works best")), file,
      h("div", { class: "row" }, go), status);
    // Arriving from a post's +, go straight to the form the first time it's drawn.
    const arrived = location.hash === "#sticker-admin" && !box.children.length;
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = file.files && file.files[0];
      if (label.value.trim().length < 2) { say("sticker-status", "Give it a name.", "error"); label.focus(); return; }
      if (!f || f.type !== "image/png") { say("sticker-status", "Choose a PNG file.", "error"); return; }
      if (f.size > 1048576) { say("sticker-status", "That PNG is over 1 MB.", "error"); return; }
      const body = new FormData();
      body.append("label", label.value.trim());
      body.append("image", f);
      go.disabled = true;
      say("sticker-status", "Uploading…");
      try {
        await api("/api/cymbal/sticker-kinds", { method: "POST", body: body });
        await loadStickerAdmin();
        say("sticker-status", "Added. Everyone can stick it on posts now.", "ok");
      } catch (err) {
        say("sticker-status", err.message, "error");
      } finally {
        go.disabled = false;
      }
    });
    const uploads = KINDS.filter((k) => k.uploaded);
    const list = uploads.length ? h("ul", { class: "kind-list" }, uploads.map((k) => h("li", { class: "kind" },
      h("img", { src: stickerSrc(k.id), alt: "" }),
      h("span", null, k.label),
      ownerNow ? h("button", { class: "link-btn", type: "button", onclick: async () => {
        if (!confirm("Remove the " + k.label + " sticker? It comes off every post it's on.")) return;
        try {
          await api("/api/cymbal/owner/sticker-kinds/" + encodeURIComponent(k.id), { method: "DELETE" });
          await loadStickerAdmin();
        } catch (err) { say("sticker-status", err.message, "error"); }
      } }, "remove") : null))) : null;
    box.replaceChildren(...[h("h2", { class: "label" }, "SUBMIT YOUR OWN STICKER"), form, list].filter(Boolean));
    if (arrived) {
      box.scrollIntoView({ block: "start" });
      if (!matchMedia("(pointer: coarse)").matches) label.focus({ preventScroll: true });
    }
  }

  // ── boot ──────────────────────────────────────────────────────────────────
  // Last, on purpose: everything below touches state declared throughout this file.

  applyFeatures();
  const kindsReady = loadKinds();
  if (PAGE === "misc") {
    loadPlaylists();
    kindsReady.then(loadLeaderboard);
  }
  if (onFeed) {
    setupComposer();
    $("more").addEventListener("click", () => loadFeed(false));
    kindsReady.then(() => loadFeed(true));
    loadPlaylists();
    pollTimer = setInterval(() => { if (!document.hidden) refreshTop(); }, 45000);
  }

  const q = new URLSearchParams(location.search);
  const done = q.get("connected");
  const failed = q.get("connect");
  if (done && LABELS[done]) say("composer-status", LABELS[done] + " connected.", "ok");
  else if (failed === "denied") say("composer-status", "Connection was cancelled.", "error");
  else if (failed) say("composer-status", "That connection didn't complete. Try again from the owner panel.", "error");
  if (done || failed) history.replaceState(null, "", location.pathname);

  // onChange calls back immediately with the current session, then on every change.
  // Anyone can sign in: that turns on the "members" features and stickers. The owner
  // panel and sticker uploads are the owner's alone.
  let whoState = null;
  PBAuth.onChange((user) => {
    const owner = !!user && user.role === "admin";
    // Remove buttons, stickers and panels depend on who is looking, so they're redrawn
    // when that changes, and only then: saving a new name mustn't redraw the page.
    const who = owner ? "owner" : user ? "user:" + user.id : "";
    const changed = whoState !== who;
    ownerNow = owner;
    memberNow = !!user;
    applyFeatures();
    showAccount(user);
    if (user && mode !== "reset") closeLogin();
    // A new account's name becomes the name it posts under, unless one is remembered.
    if (user && onFeed && !savedName() && user.name) { rememberName(user.name); $("name").value = user.name; showName(false); }
    showStickerDock(onFeed && !!user && !on("stickerButton"));
    const miscHere = PAGE === "misc";
    if (owner) {
      // With the misc page on, the owner panel lives there; Apple Music still
      // drains from the feed page in an authorised browser.
      if (!changed) { /* already drawn for the owner */ }
      else if (miscHere || !on("miscPage")) loadOwner();
      else appleAutoStart();
    } else {
      $("owner").hidden = true;
      $("owner").replaceChildren();
      stopApple();
    }
    if (miscHere && changed) {
      loadProfile();
      loadStickerAdmin();
      // The + beside a post's stickers lands here; submitting one needs an account.
      if (location.hash === "#sticker-admin" && !memberNow && $("owner-login").hidden) {
        $("account").click();
        say("owner-login-status", "Sign in or make an account to submit a sticker.");
      }
    }
    if (onFeed && whoState !== null && changed) loadFeed(true);
    whoState = who;
  });
})();
