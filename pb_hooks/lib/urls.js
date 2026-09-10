/*
 * lib/urls.js — which links Cymbal accepts, decided WITHOUT touching the network.
 *
 * Pure: no PocketBase globals, so tests/unit loads this exact file under node.
 *
 * Goja has no URL class, so parsing is by hand and deliberately narrow: https only,
 * no userinfo, no port, an exact host from the allowlist, and a path that names ONE
 * song. Anything else is refused before any server-side fetch happens. That ordering
 * is what makes the lookups that follow safe: the host a hook talks to is always one
 * of ours, never one the caller chose. Short links (spotify.link, apple.co) would
 * need a redirect to resolve, so they are refused with a hint instead of followed.
 */

const PROVIDERS = ["spotify", "apple_music", "youtube"];

const LABELS = { spotify: "Spotify", apple_music: "Apple Music", youtube: "YouTube" };

const HOSTS = {
  "open.spotify.com": "spotify",
  "music.apple.com": "apple_music",
  "www.youtube.com": "youtube",
  "youtube.com": "youtube",
  "m.youtube.com": "youtube",
  "music.youtube.com": "youtube",
  "youtu.be": "youtube",
};

const SHORT_HOSTS = ["spotify.link", "spoti.fi", "apple.co", "itun.es", "youtube.app.goo.gl"];

const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;
const APPLE_ID = /^[0-9]{1,15}$/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const STOREFRONT = /^[a-z]{2}$/;

function fail(code, message) {
  return { ok: false, code: code, message: message };
}

function ok(provider, id, canonicalUrl, extra) {
  const out = { ok: true, provider: provider, id: id, canonicalUrl: canonicalUrl };
  if (extra) for (const k in extra) out[k] = extra[k];
  return out;
}

// scheme://authority/path?query#fragment, or null. Whitespace, control characters
// and backslashes are refused outright: they are where parser differentials live.
function split(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s || s.length > 500) return null;
  if (/[\s\u0000-\u001f\u007f\\]/.test(s)) return null;
  const m = s.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^\/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/);
  if (!m) return null;
  return {
    scheme: m[1].toLowerCase(),
    authority: m[2],
    path: m[3] || "/",
    query: m[4] ? m[4].slice(1) : "",
  };
}

// First-wins would let `?v=a&v=b` mean different things to us and to YouTube, so a
// repeated key is reported and the caller refuses the link.
function params(query) {
  const out = Object.create(null);
  let repeated = false;
  if (query) {
    const pairs = query.split("&");
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      if (!pair) continue;
      const at = pair.indexOf("=");
      let key;
      let val;
      try {
        key = decodeURIComponent((at === -1 ? pair : pair.slice(0, at)).replace(/\+/g, " "));
        val = decodeURIComponent((at === -1 ? "" : pair.slice(at + 1)).replace(/\+/g, " "));
      } catch (_) {
        return null;
      }
      if (key in out) repeated = true;
      else out[key] = val;
    }
  }
  return { values: out, repeated: repeated };
}

function hostOf(authority) {
  if (!authority || authority.indexOf("@") !== -1) return null;
  let host = authority.toLowerCase();
  if (host.charAt(host.length - 1) === ".") host = host.slice(0, -1);
  if (!/^[a-z0-9.-]+$/.test(host)) return null; // no port, no IP literal, no IDN
  return host;
}

function segments(path) {
  return path.split("/").filter((s) => s.length > 0);
}

function parseSpotify(segs) {
  if (segs.length && /^intl-[a-z]{2}(-[a-z]{2})?$/i.test(segs[0])) segs = segs.slice(1);
  if (segs[0] === "embed") segs = segs.slice(1);
  if (segs.length === 2 && segs[0] === "track") {
    if (!SPOTIFY_ID.test(segs[1])) return fail("invalid_url", "That Spotify link has a malformed track id.");
    return ok("spotify", segs[1], "https://open.spotify.com/track/" + segs[1]);
  }
  const kind = segs[0] || "page";
  if (["album", "playlist", "artist", "episode", "show", "user", "collection", "audiobook"].indexOf(kind) !== -1) {
    return fail("not_a_song", "That's a Spotify " + kind + ", not a single track.");
  }
  return fail("not_a_song", "Paste a link to one Spotify track.");
}

function parseApple(segs, query) {
  if (segs.length < 2 || !STOREFRONT.test(segs[0])) {
    return fail("not_a_song", "Paste a link to one Apple Music song.");
  }
  const storefront = segs[0];
  const kind = segs[1];
  const last = segs[segs.length - 1];
  if (kind === "song" && (segs.length === 3 || segs.length === 4)) {
    if (!APPLE_ID.test(last)) return fail("invalid_url", "That Apple Music link has a malformed song id.");
    return ok("apple_music", last, "https://music.apple.com/" + storefront + "/song/" + last,
      { storefront: storefront });
  }
  if (kind === "album" && (segs.length === 3 || segs.length === 4)) {
    const song = query.values.i;
    if (song === undefined) return fail("not_a_song", "That's an Apple Music album. Open the song and share that instead.");
    if (!APPLE_ID.test(song)) return fail("invalid_url", "That Apple Music link has a malformed song id.");
    return ok("apple_music", song, "https://music.apple.com/" + storefront + "/song/" + song,
      { storefront: storefront });
  }
  if (["playlist", "artist", "station", "music-video", "curator", "room"].indexOf(kind) !== -1) {
    return fail("not_a_song", "That's an Apple Music " + kind.replace("-", " ") + ", not a single song.");
  }
  return fail("not_a_song", "Paste a link to one Apple Music song.");
}

function parseYouTube(host, segs, query) {
  let id = null;
  if (host === "youtu.be") {
    if (segs.length === 1) id = segs[0];
  } else if (segs.length === 1 && segs[0] === "watch") {
    id = query.values.v === undefined ? null : query.values.v;
    if (id === null && query.values.list !== undefined) {
      return fail("not_a_song", "That's a YouTube playlist, not a single video.");
    }
  } else if (segs.length === 2 && segs[0] === "shorts") {
    id = segs[1];
  } else {
    const kind = segs[0] || "";
    if (kind === "playlist") return fail("not_a_song", "That's a YouTube playlist, not a single video.");
    if (kind === "live") return fail("not_a_song", "Live streams can't go on a playlist.");
    if (kind === "channel" || kind === "c" || kind === "user" || kind.charAt(0) === "@") {
      return fail("not_a_song", "That's a YouTube channel, not a single video.");
    }
    return fail("not_a_song", "Paste a link to one YouTube video.");
  }
  if (id === null || !YOUTUBE_ID.test(id)) return fail("invalid_url", "That YouTube link has a malformed video id.");
  return ok("youtube", id, "https://www.youtube.com/watch?v=" + id);
}

// The one entry point for anything a person pastes: a post, or the owner's exact-link
// repair. Returns {ok:true, provider, id, canonicalUrl[, storefront]} or
// {ok:false, code, message}; `message` is safe to show as-is.
function parseTrackUrl(raw) {
  const u = split(raw);
  if (!u) return fail("invalid_url", "That doesn't look like a link.");
  if (u.scheme !== "https") return fail("insecure_url", "Links must start with https://.");
  const host = hostOf(u.authority);
  if (!host) return fail("unsupported_host", "Paste a Spotify, Apple Music or YouTube song link.");
  if (SHORT_HOSTS.indexOf(host) !== -1) {
    return fail("short_link", "Short links aren't accepted. Open it and share the full song link instead.");
  }
  const provider = HOSTS[host];
  if (!provider) return fail("unsupported_host", "Paste a Spotify, Apple Music or YouTube song link.");
  const query = params(u.query);
  if (!query) return fail("invalid_url", "That link's query string is malformed.");
  if (query.repeated) return fail("invalid_url", "That link repeats a parameter, so it's ambiguous.");
  const segs = segments(u.path);
  if (provider === "spotify") return parseSpotify(segs);
  if (provider === "apple_music") return parseApple(segs, query);
  return parseYouTube(host, segs, query);
}

// The owner's fallback share link for the Apple playlist, which Apple only exposes
// once the playlist has synced to its catalogue.
function parseApplePlaylistUrl(raw) {
  const u = split(raw);
  if (!u || u.scheme !== "https" || hostOf(u.authority) !== "music.apple.com") {
    return fail("invalid_url", "Paste the playlist's music.apple.com share link.");
  }
  const segs = segments(u.path);
  const id = segs[segs.length - 1] || "";
  if (!STOREFRONT.test(segs[0] || "") || segs[1] !== "playlist" || !/^pl\.(u-)?[A-Za-z0-9]{6,64}$/.test(id)) {
    return fail("invalid_url", "Paste the playlist's music.apple.com share link.");
  }
  return ok("apple_music", id, "https://music.apple.com/" + segs[0] + "/playlist/" + id);
}

function trackUrl(provider, id, storefront) {
  if (provider === "spotify") return "https://open.spotify.com/track/" + id;
  if (provider === "apple_music") return "https://music.apple.com/" + (storefront || "gb") + "/song/" + id;
  if (provider === "youtube") return "https://www.youtube.com/watch?v=" + id;
  return "";
}

module.exports = {
  PROVIDERS: PROVIDERS,
  LABELS: LABELS,
  parseTrackUrl: parseTrackUrl,
  parseApplePlaylistUrl: parseApplePlaylistUrl,
  trackUrl: trackUrl,
};
