/*
 * lib/match.js — whether a candidate is the SAME recording as a post. Nothing else.
 *
 * Pure: the provider adapters fetch candidates, this module decides. It never
 * guesses. A candidate must agree on title, artist, version qualifiers and duration,
 * and the agreeing candidates must collapse to exactly one recording — otherwise the
 * answer is "no match" and a person repairs it with an exact link. There are no fuzzy
 * scores, no embeddings and no model here, on purpose: a wrong song silently added to
 * three playlists is worse than a visible "attention".
 *
 * Qualifiers (live, remix, remaster, acoustic, cover, sped up, slowed, ...) are part of
 * what a recording IS and must match exactly. Presentation noise ("official video",
 * "lyrics", "HD") is stripped. Featured-artist credits are dropped from titles.
 */

const QUALIFIER_RULES = [
  { key: "sped_up", re: /\bsped up\b|\bspeed up\b|\bnightcore\b/ },
  { key: "slowed", re: /\bslowed\b/ },
  { key: "reverb", re: /\breverb\b/ },
  { key: "remaster", re: /\bremaster(ed)?\b|\bremastering\b/ },
  { key: "live", re: /\blive\b/ },
  { key: "acoustic", re: /\bacoustic\b/ },
  { key: "unplugged", re: /\bunplugged\b/ },
  { key: "cover", re: /\bcover\b/ },
  { key: "instrumental", re: /\binstrumental\b/ },
  { key: "acapella", re: /\ba ?capp?ella\b/ },
  { key: "demo", re: /\bdemo\b/ },
  { key: "karaoke", re: /\bkaraoke\b/ },
  { key: "extended", re: /\bextended\b/ },
  { key: "edit", re: /\bradio (edit|mix|version)\b|\bedit\b/ },
  { key: "mono", re: /\bmono\b/ },
  { key: "rerecorded", re: /\btaylors version\b|\bre ?recorded\b/ },
  { key: "orchestral", re: /\borchestral\b|\bsymphonic\b/ },
];

// Segments that say nothing about which recording this is.
const NEUTRAL = [
  /^(album|single|lp|original|main|stereo) (version|mix|edit)$/,
  /^(explicit|clean)( version)?$/,
  /^bonus( track)?$/,
  /^(19|20)[0-9]{2}$/,
  /^from .+$/,
  /^soundtrack$/,
];

// Presentation noise, mostly from YouTube titles.
const NOISE = /^(official )?((music|lyric|lyrics|audio|video|visuali[sz]er|mv|m v|hd|hq|4k|8k|clip|videoclip)( ?video)?|official|lyrics?|with lyrics|colou?r coded lyrics|audio|video|visuali[sz]er|premiere|out now|new song)$/;
const PROD_CREDIT = /^prod(uced)?( by)? .+$/;
const FEAT = /^(feat|ft|featuring|with) .+$/;

function normalize(s) {
  let t = String(s == null ? "" : s);
  try { t = t.normalize("NFKD"); } catch (_) { /* goja without norm: compare as given */ }
  t = t.replace(/[\u0300-\u036f]/g, "").toLowerCase();
  t = t.replace(/&/g, " and ").replace(/['\u2018\u2019`\u00b4]/g, "");
  // ASCII and common Unicode punctuation become spaces; letters in any script stay.
  t = t.replace(/[\s!-\/:-@\[-`{-~\u2000-\u206f\u3000-\u303f\uff01-\uff0f\u00a0-\u00bf\u00d7\u00f7]+/g, " ");
  return t.trim().replace(/\s+/g, " ");
}

// What a bracket or dash segment contributes: {drop, qualifiers[]}. A segment that is
// neither a qualifier nor noise is part of the title and stays — "(I Can't Get No)
// Satisfaction" keeps its parenthesis.
function classify(segment) {
  const n = normalize(segment);
  if (!n) return { drop: true, qualifiers: [] };
  if (FEAT.test(n) || PROD_CREDIT.test(n) || NOISE.test(n)) return { drop: true, qualifiers: [] };
  for (let i = 0; i < NEUTRAL.length; i++) if (NEUTRAL[i].test(n)) return { drop: true, qualifiers: [] };
  const found = [];
  for (let i = 0; i < QUALIFIER_RULES.length; i++) {
    if (QUALIFIER_RULES[i].re.test(n)) found.push(QUALIFIER_RULES[i].key);
  }
  if (/\bre ?mix(ed)?\b|\brmx\b|\bbootleg\b|\bvip\b/.test(n) ||
      (/\bmix\b/.test(n) && !/\b(extended|radio|original|album|single|main) mix\b/.test(n))) {
    found.push("remix");
  }
  if (/\bversion\b/.test(n) && !found.length) {
    // Any other named version ("Spanish Version", "Piano Version") is its own recording.
    found.push("v:" + n.replace(/\b(19|20)[0-9]{2}\b/g, "").trim().replace(/\s+/g, " "));
  }
  if (found.length) return { drop: true, qualifiers: found };
  return { drop: false, qualifiers: [] };
}

// Title -> {base, qualifiers}. base is normalized; qualifiers is a sorted unique list.
function parseTitle(raw) {
  let title = String(raw == null ? "" : raw);
  const qualifiers = [];
  const take = (list) => { for (let i = 0; i < list.length; i++) if (qualifiers.indexOf(list[i]) === -1) qualifiers.push(list[i]); };

  title = title.replace(/[\(\[\{\uff08\u3010]([^\)\]\}\uff09\u3011]*)[\)\]\}\uff09\u3011]/g, (whole, inner) => {
    const c = classify(inner);
    take(c.qualifiers);
    return c.drop ? " " : whole;
  });

  // " - 2011 Remaster", " - Live at Wembley", " | Official Video". The first part is
  // always kept; later parts are judged like bracket segments.
  const parts = title.split(/\s+[-\u2013\u2014|]\s+|\s+\/\/\s+/);
  const kept = [parts[0]];
  for (let i = 1; i < parts.length; i++) {
    const c = classify(parts[i]);
    take(c.qualifiers);
    if (!c.drop) kept.push(parts[i]);
  }
  title = kept.join(" ");
  title = title.replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, "");

  qualifiers.sort();
  return { base: normalize(title), qualifiers: qualifiers };
}

function artistKey(a) {
  return normalize(a).replace(/^the /, "");
}

function compact(s) {
  return s.replace(/ /g, "");
}

// One credit string can hold several names ("A & B", "A, B and C", "A x B"). The
// primary is the first name of the first credit; `names` holds every whole credit
// and every name split out of one.
function artistNames(list) {
  const names = [];
  let primary = "";
  (list || []).forEach((credit) => {
    const k = artistKey(credit);
    if (!k) return;
    if (names.indexOf(k) === -1) names.push(k);
    k.split(/ and | x | feat | ft | featuring | with |, ?/).forEach((p) => {
      const q = p.trim().replace(/^the /, "");
      if (!q) return;
      if (!primary) primary = q;
      if (names.indexOf(q) === -1) names.push(q);
    });
  });
  return { primary: primary, names: names };
}

// Each side's PRIMARY artist must appear among the other side's names.
function artistsAgree(a, b) {
  const an = artistNames(a);
  const bn = artistNames(b);
  if (!an.primary || !bn.primary) return false;
  const has = (names, x) => names.some((n) => n === x || compact(n) === compact(x));
  return has(bn.names, an.primary) && has(an.names, bn.primary);
}

function durationAgrees(a, b, tolMs) {
  const x = Number(a);
  const y = Number(b);
  if (!(x > 0) || !(y > 0)) return false;
  return Math.abs(x - y) <= tolMs;
}

function isrcKey(s) {
  const k = String(s == null ? "" : s).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$/.test(k) ? k : "";
}

function sameList(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toleranceFor(sourceProvider, targetProvider) {
  return sourceProvider === "youtube" || targetProvider === "youtube" ? 5000 : 3000;
}

// ── provider resource -> candidate (the shape decide() reads) ────────────────

function fromSpotifyTrack(t) {
  if (!t || !t.id || t.is_local) return null;
  const album = t.album || {};
  return {
    provider: "spotify",
    id: t.id,
    title: t.name || "",
    artists: (t.artists || []).map((a) => a && a.name).filter(Boolean),
    durationMs: Number(t.duration_ms) || 0,
    isrc: isrcKey(t.external_ids && t.external_ids.isrc),
    albumType: album.album_type || "",
    releaseDate: album.release_date || "",
    url: "https://open.spotify.com/track/" + t.id,
  };
}

function fromAppleSong(s, storefront) {
  if (!s || !s.id) return null;
  const a = s.attributes || {};
  const albumName = a.albumName || "";
  return {
    provider: "apple_music",
    id: String(s.id),
    title: a.name || "",
    artists: a.artistName ? [a.artistName] : [],
    durationMs: Number(a.durationInMillis) || 0,
    isrc: isrcKey(a.isrc),
    albumType: /- single$/i.test(albumName) ? "single" : (/- ep$/i.test(albumName) ? "single" : "album"),
    releaseDate: a.releaseDate || "",
    url: a.url || ("https://music.apple.com/" + (storefront || "gb") + "/song/" + s.id),
  };
}

function parseIsoDuration(s) {
  const m = String(s || "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return 0;
  return ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0)) * 1000;
}

function isTopicChannel(channel) {
  return / - topic$/i.test(String(channel || ""));
}

function channelArtist(channel) {
  return String(channel || "").replace(/ - topic$/i, "").replace(/vevo$/i, "").replace(/\bofficial\b/i, "").trim();
}

// YouTube has no artist field. In order of trust: the auto-generated "Provided to
// YouTube" description ("Title · Artist"), a Topic channel, "Artist - Title", and
// finally the channel name.
function parseYouTubeMeta(title, channel, description) {
  const desc = String(description || "");
  if (/^provided to youtube by /i.test(desc)) {
    const paras = desc.split(/\n\s*\n/);
    if (paras.length > 1 && paras[1].indexOf(" \u00b7 ") !== -1) {
      const bits = paras[1].split(" \u00b7 ").map((x) => x.trim()).filter(Boolean);
      if (bits.length >= 2) return { title: bits[0], artists: bits.slice(1), autoGenerated: true };
    }
  }
  if (isTopicChannel(channel)) return { title: String(title || ""), artists: [channelArtist(channel)], autoGenerated: true };
  const m = String(title || "").match(/^(.+?)\s+[-\u2013\u2014]\s+(.+)$/);
  if (m) return { title: m[2], artists: [m[1]], autoGenerated: false };
  return { title: String(title || ""), artists: [channelArtist(channel)], autoGenerated: false };
}

function fromYouTubeVideo(v) {
  if (!v || !v.id) return null;
  const sn = v.snippet || {};
  const cd = v.contentDetails || {};
  const st = v.status || {};
  const meta = parseYouTubeMeta(sn.title, sn.channelTitle, sn.description);
  return {
    provider: "youtube",
    id: String(v.id),
    title: meta.title,
    artists: meta.artists,
    durationMs: parseIsoDuration(cd.duration),
    isrc: "",
    channel: sn.channelTitle || "",
    licensed: !!cd.licensedContent,
    privacy: st.privacyStatus || "",
    uploadStatus: st.uploadStatus || "",
    live: (sn.liveBroadcastContent && sn.liveBroadcastContent !== "none") || !!v.liveStreamingDetails,
    categoryId: String(sn.categoryId || ""),
    url: "https://www.youtube.com/watch?v=" + v.id,
  };
}

// 1 = Topic (the label's own audio upload), 2 = VEVO or the artist's own channel,
// 3 = licensed content from elsewhere. 0 = not an acceptable YouTube target at all.
function youtubeTier(c, sourceArtists) {
  if (c.privacy !== "public" || c.uploadStatus !== "processed" || c.live || c.categoryId !== "10") return 0;
  const owner = channelArtist(c.channel);
  const ownerAgrees = !!owner && artistsAgree([owner], sourceArtists);
  if (isTopicChannel(c.channel) && ownerAgrees) return 1;
  if (/vevo$/i.test(compact(normalize(c.channel))) || ownerAgrees) return 2;
  if (c.licensed) return 3;
  return 0;
}

const ALBUM_RANK = { album: 0, single: 1, compilation: 2 };

// decide(source, candidates, {target, isrc?}) ->
//   {matched:true, candidate, evidence} | {matched:false, reason, evidence}
// `isrc` set means candidates were found BY that ISRC and must carry it.
function decide(source, candidates, opts) {
  const target = opts.target;
  const tol = toleranceFor(source.provider, target);
  const want = parseTitle(source.title);
  const agreeing = [];
  const rejected = [];
  const seen = {};

  (candidates || []).forEach((c) => {
    if (!c || !c.id || seen[c.id]) return;
    seen[c.id] = true;
    const reasons = [];
    if (opts.isrc && c.isrc !== isrcKey(opts.isrc)) reasons.push("isrc");
    const got = parseTitle(c.title);
    if (!want.base || got.base !== want.base) reasons.push("title");
    if (!sameList(got.qualifiers, want.qualifiers)) reasons.push("version");
    if (!artistsAgree(source.artists, c.artists)) reasons.push("artist");
    if (!durationAgrees(source.durationMs, c.durationMs, tol)) reasons.push("duration");
    let tier = 0;
    if (target === "youtube") {
      tier = youtubeTier(c, source.artists);
      if (!tier) reasons.push("channel");
    }
    if (reasons.length) rejected.push({ id: c.id, reasons: reasons });
    else agreeing.push({ c: c, tier: tier });
  });

  const evidence = {
    want: { title: want.base, qualifiers: want.qualifiers, artists: source.artists, duration_ms: source.durationMs },
    considered: agreeing.length + rejected.length,
    rejected: rejected.slice(0, 10),
  };
  if (!agreeing.length) return { matched: false, reason: "no_match", evidence: evidence };

  let pick;
  if (target === "youtube") {
    let best = 99;
    agreeing.forEach((a) => { if (a.tier < best) best = a.tier; });
    const top = agreeing.filter((a) => a.tier === best);
    if (top.length !== 1) {
      evidence.ambiguous = top.map((a) => a.c.id);
      return { matched: false, reason: "ambiguous", evidence: evidence };
    }
    pick = top[0].c;
    evidence.tier = best;
  } else {
    // Several ids with ONE ISRC are one recording on several releases (album and
    // single). Different ISRCs are different recordings: that is ambiguity, not a
    // choice to make on someone's behalf.
    const groups = {};
    agreeing.forEach((a) => {
      const k = a.c.isrc || ("id:" + a.c.id);
      (groups[k] = groups[k] || []).push(a.c);
    });
    const keys = Object.keys(groups);
    if (keys.length !== 1) {
      evidence.ambiguous = keys;
      return { matched: false, reason: "ambiguous", evidence: evidence };
    }
    const group = groups[keys[0]].slice().sort((x, y) => {
      const rx = ALBUM_RANK[x.albumType] === undefined ? 3 : ALBUM_RANK[x.albumType];
      const ry = ALBUM_RANK[y.albumType] === undefined ? 3 : ALBUM_RANK[y.albumType];
      if (rx !== ry) return rx - ry;
      const dx = x.releaseDate || "9999";
      const dy = y.releaseDate || "9999";
      if (dx !== dy) return dx < dy ? -1 : 1;
      return x.id < y.id ? -1 : (x.id > y.id ? 1 : 0);
    });
    pick = group[0];
  }
  evidence.picked = { id: pick.id, title: pick.title, artists: pick.artists, duration_ms: pick.durationMs, isrc: pick.isrc || "" };
  return { matched: true, candidate: pick, evidence: evidence };
}

// Words to search a target catalogue with. Qualifiers go in so "live" finds the live
// recording; decide() still insists on exact agreement afterwards.
function searchTerms(source) {
  const t = parseTitle(source.title);
  const words = t.qualifiers.filter((q) => q.indexOf("v:") !== 0).map((q) => q.replace("_", " "));
  const artist = (source.artists && source.artists[0]) || "";
  return {
    title: String(source.title || "").replace(/[\(\[].*?[\)\]]/g, " ").split(/\s+[-\u2013\u2014|]\s+/)[0]
      .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, "").replace(/["]/g, "").trim(),
    artist: artist.replace(/["]/g, "").trim(),
    qualifiers: words,
  };
}

module.exports = {
  normalize: normalize,
  parseTitle: parseTitle,
  artistsAgree: artistsAgree,
  durationAgrees: durationAgrees,
  isrcKey: isrcKey,
  toleranceFor: toleranceFor,
  parseIsoDuration: parseIsoDuration,
  parseYouTubeMeta: parseYouTubeMeta,
  fromSpotifyTrack: fromSpotifyTrack,
  fromAppleSong: fromAppleSong,
  fromYouTubeVideo: fromYouTubeVideo,
  youtubeTier: youtubeTier,
  decide: decide,
  searchTerms: searchTerms,
};
