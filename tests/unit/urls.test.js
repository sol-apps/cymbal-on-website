// node --test tests/unit — loads the SAME file the server runs.
const test = require("node:test");
const assert = require("node:assert/strict");
const urls = require("../../pb_hooks/lib/urls.js");

const SP = "4uLU6hMCjMI75M1A2tKUQC";

function accepts(raw, provider, id) {
  const r = urls.parseTrackUrl(raw);
  assert.equal(r.ok, true, raw + " -> " + JSON.stringify(r));
  assert.equal(r.provider, provider);
  assert.equal(r.id, id);
  return r;
}

function refuses(raw, code) {
  const r = urls.parseTrackUrl(raw);
  assert.equal(r.ok, false, raw + " should be refused");
  if (code) assert.equal(r.code, code, raw + " -> " + r.code);
  assert.ok(r.message && r.message.length < 120);
  return r;
}

test("spotify tracks, with and without tracking params and intl prefix", () => {
  const r = accepts("https://open.spotify.com/track/" + SP + "?si=abc123", "spotify", SP);
  assert.equal(r.canonicalUrl, "https://open.spotify.com/track/" + SP);
  accepts("https://open.spotify.com/intl-de/track/" + SP, "spotify", SP);
  accepts("https://OPEN.SPOTIFY.COM/track/" + SP, "spotify", SP);
});

test("spotify non-tracks are refused before any fetch", () => {
  refuses("https://open.spotify.com/album/" + SP, "not_a_song");
  refuses("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", "not_a_song");
  refuses("https://open.spotify.com/episode/" + SP, "not_a_song");
  refuses("https://open.spotify.com/track/short", "invalid_url");
  refuses("https://spotify.link/abcdef", "short_link");
});

test("apple music songs and album links naming one song", () => {
  const a = accepts("https://music.apple.com/gb/song/bohemian-rhapsody/1440650711", "apple_music", "1440650711");
  assert.equal(a.canonicalUrl, "https://music.apple.com/gb/song/1440650711");
  assert.equal(a.storefront, "gb");
  accepts("https://music.apple.com/us/album/a-night-at-the-opera/1440650428?i=1440650711", "apple_music", "1440650711");
  accepts("https://music.apple.com/gb/song/1440650711", "apple_music", "1440650711");
  refuses("https://music.apple.com/us/album/a-night-at-the-opera/1440650428", "not_a_song");
  refuses("https://music.apple.com/gb/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb", "not_a_song");
  refuses("https://music.apple.com/gb/artist/queen/3296287", "not_a_song");
  refuses("https://apple.co/3xyz", "short_link");
});

test("youtube watch, short link, shorts and youtube music", () => {
  const w = accepts("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42", "youtube", "dQw4w9WgXcQ");
  assert.equal(w.canonicalUrl, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  accepts("https://youtu.be/dQw4w9WgXcQ?si=x", "youtube", "dQw4w9WgXcQ");
  accepts("https://www.youtube.com/shorts/dQw4w9WgXcQ", "youtube", "dQw4w9WgXcQ");
  accepts("https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=RDAMVM", "youtube", "dQw4w9WgXcQ");
  accepts("https://m.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "dQw4w9WgXcQ");
});

test("youtube playlists, channels and live streams are refused", () => {
  refuses("https://www.youtube.com/playlist?list=PL123", "not_a_song");
  refuses("https://www.youtube.com/watch?list=PL123", "not_a_song");
  refuses("https://www.youtube.com/@artist", "not_a_song");
  refuses("https://www.youtube.com/channel/UC123", "not_a_song");
  refuses("https://www.youtube.com/live/dQw4w9WgXcQ", "not_a_song");
  refuses("https://www.youtube.com/watch?v=tooshort", "invalid_url");
});

test("lookalike hosts, ports, userinfo and other SSRF shapes are refused", () => {
  refuses("http://open.spotify.com/track/" + SP, "insecure_url");
  refuses("https://open.spotify.com.evil.example/track/" + SP, "unsupported_host");
  refuses("https://evil.example/open.spotify.com/track/" + SP, "unsupported_host");
  refuses("https://open.spotify.com@evil.example/track/" + SP, "unsupported_host");
  refuses("https://user:pw@open.spotify.com/track/" + SP, "unsupported_host");
  refuses("https://open.spotify.com:8443/track/" + SP, "unsupported_host");
  refuses("https://127.0.0.1/track/" + SP, "unsupported_host");
  refuses("https://[::1]/track/" + SP, "unsupported_host");
  refuses("https://xn--pen-spotify-8kb.com/track/" + SP, "unsupported_host");
  refuses("javascript:alert(1)", "invalid_url");
  refuses("https://open.spotify.com\\@evil.example/track/" + SP, "invalid_url");
  refuses("https://open.spotify.com/track/" + SP + " https://evil.example", "invalid_url");
  refuses("https://open.spotify.com/track/" + SP + "\u0000", "invalid_url");
  refuses("", "invalid_url");
  refuses("x".repeat(600), "invalid_url");
});

test("a repeated parameter is ambiguous and refused", () => {
  refuses("https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=aaaaaaaaaaa", "invalid_url");
  refuses("https://music.apple.com/us/album/x/1?i=1&i=2", "invalid_url");
});

test("apple playlist share link for the owner's fallback", () => {
  const p = urls.parseApplePlaylistUrl("https://music.apple.com/gb/playlist/cymbal-on-website/pl.u-AkAmPlyUxX4vN8");
  assert.equal(p.ok, true);
  assert.equal(p.id, "pl.u-AkAmPlyUxX4vN8");
  assert.equal(urls.parseApplePlaylistUrl("https://music.apple.com/gb/album/x/123").ok, false);
  assert.equal(urls.parseApplePlaylistUrl("https://evil.example/gb/playlist/x/pl.u-AkAmPlyUxX4vN8").ok, false);
});
