/* app.js — Cymbal's page. Plain DOM, no framework, no build step.
 *
 * Every piece of text that came from a person or a provider — captions, comments,
 * names, track titles — reaches the page through textContent (h() below) and is
 * never parsed as HTML. Links are only ever https URLs the server built from
 * validated ids.
 *
 * Sessions are thirty minutes and are never renewed silently (pb-auth.js). When one
 * lapses the page shows its sign-in control and waits for a click, because a popup
 * opened without one is blocked.
 */
(() => {
  "use strict";

  const pb = PBAuth.getClient();
  pb.autoCancellation(false);

  const $ = (id) => document.getElementById(id);
  const ORDER = ["spotify", "apple_music", "youtube"];
  const LABELS = { spotify: "Spotify", apple_music: "Apple Music", youtube: "YouTube" };
  const STATE_TEXT = { pending: "pending", synced: "synced", attention: "attention", cancelled: "cancelled" };
  const STATE_MARK = { pending: "…", synced: "✓", attention: "!", cancelled: "×" };

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

  function requestId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
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

  async function api(path, opts) {
    try {
      return await pb.send(path, Object.assign({ method: "GET" }, opts || {}));
    } catch (err) {
      const status = err && err.status;
      if (status === 401) PBAuth.signOut();
      const msg = (err && err.response && err.response.message) ||
        (status === 0 ? "Couldn't reach Cymbal. Check your connection." : "Something went wrong. Try again.");
      const e = new Error(msg);
      e.status = status;
      throw e;
    }
  }

  // ── sign-in state ─────────────────────────────────────────────────────────

  // null, not "": the first onChange call must always render, and signed-out is "".
  let currentUser = null;
  let wasSignedIn = false;


  $("signin").addEventListener("click", async () => {
    const btn = $("signin");
    btn.disabled = true;
    say("gate-status", "Opening sign-in…");
    try {
      await PBAuth.signIn();
      say("gate-status", "");
    } catch (err) {
      say("gate-status", "Sign-in didn't complete. If you haven't been given access to Cymbal yet, ask the owner.", "error");
    } finally {
      btn.disabled = false;
    }
  });

  $("signout").addEventListener("click", () => {
    wasSignedIn = false;
    PBAuth.signOut();
    say("gate-status", "Signed out.");
  });

  let pollTimer = null;
  let appleTimer = null;

  function start() {
    loadPlaylists();
    loadFeed(true);
    if (PBAuth.isAdmin()) loadOwner();
    else $("owner").hidden = true;
    clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (!document.hidden) refreshTop(); }, 45000);
    const q = new URLSearchParams(location.search);
    const done = q.get("connected");
    const failed = q.get("connect");
    if (done && LABELS[done]) say("composer-status", LABELS[done] + " connected.", "ok");
    else if (failed === "denied") say("composer-status", "Connection was cancelled.", "error");
    else if (failed) say("composer-status", "That connection didn't complete. Try again from the owner panel.", "error");
    if (done || failed) history.replaceState(null, "", location.pathname);
  }

  function stop() {
    clearInterval(pollTimer);
    clearInterval(appleTimer);
    pollTimer = null;
    appleTimer = null;
  }

  // ── playlists ─────────────────────────────────────────────────────────────

  async function loadPlaylists() {
    let data;
    try { data = await api("/api/cymbal/playlists"); } catch (_) { return; }
    const list = $("playlists");
    list.replaceChildren(...data.playlists.map((p) => h("li", null,
      p.url && safeHref(p.url)
        ? h("a", { class: "btn", href: p.url, target: "_blank", rel: "noopener noreferrer" }, p.label.toUpperCase())
        : h("span", { class: "btn is-waiting", title: "This playlist isn't set up yet" }, p.label.toUpperCase(), h("span", { class: "visually-hidden" }, " (not set up yet)"))
    )));
  }

  // ── composer ──────────────────────────────────────────────────────────────

  // One request id per attempt at a post, kept until it succeeds, so a retry after a
  // dropped connection returns the original post instead of creating a second one.
  let postRid = null;

  $("url").addEventListener("input", () => { postRid = null; });
  $("caption").addEventListener("input", () => {
    $("caption-count").textContent = $("caption").value.length + "/500";
  });

  $("composer").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const url = $("url").value.trim();
    if (!url) {
      say("composer-status", "Paste a song link first.", "error");
      $("url").focus();
      return;
    }
    if (!postRid) postRid = requestId();
    const btn = $("post");
    btn.disabled = true;
    say("composer-status", "Posting…");
    try {
      const res = await api("/api/cymbal/posts", {
        method: "POST",
        body: { url: url, caption: $("caption").value, request_id: postRid },
      });
      postRid = null;
      $("composer").reset();
      $("caption-count").textContent = "0/500";
      upsertCard(res.post, true);
      say("composer-status", res.replayed ? "Already posted." : "Posted. It'll be added to the playlists shortly.", "ok");
    } catch (err) {
      if (err.status >= 400 && err.status < 500) postRid = null;
      say("composer-status", err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });

  // ── feed ──────────────────────────────────────────────────────────────────

  let cursor = "";
  let loading = false;

  async function loadFeed(reset) {
    if (loading) return;
    loading = true;
    if (reset) {
      cursor = "";
      $("posts").replaceChildren();
    }
    say("feed-status", "Loading…");
    try {
      const q = cursor ? "?cursor=" + encodeURIComponent(cursor) : "";
      const data = await api("/api/cymbal/feed" + q);
      data.posts.forEach((p) => upsertCard(p, false));
      cursor = data.next_cursor || "";
      $("more").hidden = !cursor;
      const empty = !$("posts").children.length;
      say("feed-status", empty ? "Nothing here yet. Post the first song." : "");
    } catch (err) {
      say("feed-status", err.message, "error");
    } finally {
      loading = false;
    }
  }

  $("more").addEventListener("click", () => loadFeed(false));

  // Re-read the newest page so titles resolve and sync states move without a reload.
  async function refreshTop() {
    try {
      const data = await api("/api/cymbal/feed");
      data.posts.slice().reverse().forEach((p) => upsertCard(p, true));
    } catch (_) { /* next tick */ }
  }

  function syncChips(p) {
    return h("ul", { class: "syncs", "aria-label": "Playlist status" }, ORDER.map((prov) => {
      const s = (p.sync && p.sync[prov]) || { state: "pending" };
      const state = STATE_TEXT[s.state] || "pending";
      const inner = [h("span", { class: "sync-mark", "aria-hidden": "true" }, STATE_MARK[state]), LABELS[prov] + " " + state];
      return h("li", { class: "sync sync-" + state },
        s.url && safeHref(s.url) ? h("a", { href: s.url, target: "_blank", rel: "noopener noreferrer" }, inner) : inner);
    }));
  }

  function buildCard(p) {
    const title = p.title || (p.resolving ? "Finding the track details…" : (p.unavailable ? "Couldn't look this one up" : "Untitled"));
    const count = p.comment_count || 0;
    const card = h("li", { class: "card panel", "data-id": p.id },
      h("div", { class: "card-head" },
        h("span", { class: "src" }, (p.source_label || "").toUpperCase()),
        h("span", null, p.poster + ", " + when(p.created))),
      h("h3", { class: "track" + (p.title ? "" : " resolving") }, extLink(p.url, title)),
      p.artist ? h("p", { class: "artist" }, p.artist) : null,
      p.caption ? h("p", { class: "caption" }, p.caption) : null,
      syncChips(p),
      h("div", { class: "card-actions" },
        h("button", {
          class: "btn btn-small js-toggle", type: "button", "aria-expanded": "false", "aria-controls": "c-" + p.id,
          onclick: () => toggleComments(card, p.id),
        }, count ? "COMMENTS (" + count + ")" : "COMMENT"),
        p.can_delete ? h("button", { class: "btn btn-small btn-quiet", type: "button", onclick: () => removePost(p.id) }, "REMOVE") : null),
      h("div", { class: "comments", id: "c-" + p.id, hidden: true }));
    return card;
  }

  // Replace a card in place (keeping an open comment thread), or add it.
  function upsertCard(p, atTop) {
    const list = $("posts");
    const old = list.querySelector('li[data-id="' + CSS.escape(p.id) + '"]');
    const card = buildCard(p);
    if (old) {
      const oldComments = old.querySelector(".comments");
      if (oldComments && !oldComments.hidden) {
        card.querySelector(".comments").replaceWith(oldComments);
        card.querySelector(".js-toggle").setAttribute("aria-expanded", "true");
      }
      old.replaceWith(card);
    } else if (atTop) {
      list.prepend(card);
    } else {
      list.append(card);
    }
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
            li.remove();
            bumpCount(card, -1);
          } catch (err) { alert(err.message); }
        } }, "remove") : null),
      h("p", { class: "comment-body" }, c.body));
    return li;
  }

  function bumpCount(card, delta) {
    const btn = card.querySelector(".js-toggle");
    const m = /\((\d+)\)/.exec(btn.textContent);
    const n = Math.max(0, (m ? Number(m[1]) : 0) + delta);
    btn.textContent = n ? "COMMENTS (" + n + ")" : "COMMENT";
  }

  function commentForm(postId, list, card) {
    let rid = null;
    const id = "cf-" + postId;
    const input = h("textarea", { id: id, rows: "2", maxlength: "1000", required: true });
    const status = h("p", { class: "status", role: "status", "aria-live": "polite" });
    const btn = h("button", { class: "btn btn-small btn-primary", type: "submit" }, "SEND");
    input.addEventListener("input", () => { rid = null; });
    const form = h("form", { class: "comment-form", novalidate: true },
      h("label", { class: "visually-hidden", for: id }, "Write a comment"),
      input, h("div", { class: "row" }, btn), status);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const body = input.value.trim();
      if (!body) { status.textContent = "Write something first."; input.focus(); return; }
      if (!rid) rid = requestId();
      btn.disabled = true;
      try {
        const res = await api("/api/cymbal/posts/" + encodeURIComponent(postId) + "/comments", {
          method: "POST", body: { body: body, request_id: rid },
        });
        rid = null;
        input.value = "";
        status.textContent = "";
        if (!res.replayed) {
          list.append(commentItem(res.comment, card));
          bumpCount(card, 1);
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

  // ── owner panel ───────────────────────────────────────────────────────────

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
    const attention = h("div", { id: "owner-attention" });
    const details = h("details", { open: sessionStorage.getItem("cymbal_owner_open") === "1" ? true : null },
      h("summary", { id: "owner-title" }, "OWNER PANEL"),
      h("div", { class: "owner-grid" },
        s.providers.map((p) => providerCard(p, s)),
        h("div", { class: "row" },
          h("button", { class: "btn btn-small", type: "button", onclick: runNow }, "SYNC NOW"),
          h("button", { class: "btn btn-small", type: "button", onclick: loadOwner }, "REFRESH")),
        s.spotify_transfer_allowed ? null :
          h("p", { class: "small" }, "Matching Spotify-posted songs to Apple Music and YouTube is off. Set CYMBAL_SPOTIFY_METADATA_TRANSFER=allowed once you've confirmed Spotify's terms permit it."),
        h("p", { class: "small" }, "Callback URLs: ", h("code", null, s.redirect_uris.spotify), " and ", h("code", null, s.redirect_uris.youtube)),
        status,
        attention));
    details.addEventListener("toggle", () => {
      try { sessionStorage.setItem("cymbal_owner_open", details.open ? "1" : "0"); } catch (_) { /* ignore */ }
    });
    box.replaceChildren(details);
    loadAttention();
    const apple = s.providers.find((p) => p.provider === "apple_music");
    if (apple && apple.configured) appleAutoStart();
  }

  function countsLine(p) {
    const c = p.counts || {};
    const bits = [];
    if (c.pending) bits.push(c.pending + " waiting");
    if (c.pending_device) bits.push(c.pending_device + " waiting for this browser");
    if (c.attention) bits.push(c.attention + " need a look");
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
      loadPlaylists();
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
    return h("li", null,
      h("strong", null, (r.post ? (r.post.title || "Untitled") + (r.post.artist ? " by " + r.post.artist : "") : "Removed post") + " to " + r.target_label),
      r.post ? h("span", { class: "small" }, extLink(r.post.url, "original link")) : null,
      h("span", null, r.detail || r.reason),
      steps ? h("span", { class: "small" }, "Tried " + steps) : null,
      form,
      h("div", { class: "row" }, h("button", { class: "btn btn-small", type: "button", onclick: async () => {
        try {
          await api("/api/cymbal/owner/syncs/" + r.id + "/retry", { method: "POST" });
          ownerSay("Queued again.", "ok");
          loadAttention();
        } catch (err) { ownerSay(err.message, "error"); }
      } }, "RETRY")));
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
    if (music.isAuthorized) {
      try { localStorage.setItem("cymbal_apple_authorised", "1"); } catch (_) { /* ignore */ }
    }
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
    let before = null;
    try { before = localStorage.getItem("cymbal_apple_authorised"); } catch (_) { /* ignore */ }
    if (before !== "1") return;
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
            loadPlaylists();
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
        loadPlaylists();
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

  // ── boot ──────────────────────────────────────────────────────────────────
  // Last, on purpose: onChange calls back immediately, and start() touches state
  // declared throughout this file. Registered any earlier, it reads those
  // `let`s before they exist.

  PBAuth.onChange((user) => {
    const id = user ? user.id : "";
    if (id === currentUser) return;
    currentUser = id;
    if (user) {
      wasSignedIn = true;
      $("gate").hidden = true;
      $("app").hidden = false;
      $("signout").hidden = false;
      start();
    } else {
      stop();
      $("app").hidden = true;
      $("signout").hidden = true;
      $("gate").hidden = false;
      if (wasSignedIn) say("gate-status", "Your session ended. Sign in again to carry on.");
    }
  });
})();
