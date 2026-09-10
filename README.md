---
solhann_app: true
slug: cymbal-on-website
title: Cymbal on Website
description: Friends share music, talk about it, and keep three playlists in sync.
emoji: 🥁
---

# Cymbal on Website

Friends post a Spotify, Apple Music or YouTube song link, add a caption, and talk
about it. Every post is also added to three playlists called **Cymbal on Website** on
the owner's Spotify, YouTube and Apple Music accounts.

**Live:** https://cymbal-on-website.solhann.net

## Who can use it

The page and this repository are public; the posts are not. Cymbal is a governed
app: sign-in goes through `id.solhann.net`, and only people granted access to
`cymbal-on-website` on `id-admin.solhann.net` can sign in at all. Grant friends
`user` and the owner `admin`. The owner sees the owner panel; friends never connect a
music account.

## How a post reaches three playlists

- The link someone posts is authoritative and never rewritten.
- A one-minute worker (`pb_hooks/lib/sync.js`) looks the track up on its own service,
  then finds it on the other two in a fixed order: a unique ISRC match, a unique
  MusicBrainz relationship, then a unique exact title/artist/version match within
  3s (5s involving YouTube). Live, remix, remaster, acoustic, cover, sped-up and
  slowed versions must match exactly. No fuzzy matching and no AI.
- Anything uncertain is marked **attention** instead of guessed; the owner fixes it
  by pasting the exact link.
- Each playlist holds a song once, however many times it is posted
  (`playlist_memberships`). A write whose outcome is unknown is verified against the
  playlist before any retry.
- Spotify and YouTube update in the background. Apple Music writes need the owner's
  Music User Token, which Apple ties to one browser, so they wait in `pending_device`
  until the owner opens Cymbal in an authorised browser, which then drains them.
- Playlists are append-only in v1. Personal playlist export is deferred.

## Layout

    index.html app.js app.css theme.js   the page (no build step)
    privacy.html terms.html              what is stored and how the playlists behave
    pb-auth.js pb_hooks/identity.pb.js pb_migrations/1756540000_identity.js
                                         the platform identity layer: do not edit
    pb_migrations/1757520000_cymbal_schema.js   Cymbal's collections, all rules null
    pb_hooks/main.pb.js                  routes + the cron
    pb_hooks/lib/                        urls, match (pure), feed, sync, providers, owner
    tests/unit                           node --test, loads the same lib files
    tests/api                            end-to-end against a local PocketBase + mock providers
    tools/apple-dev-token.py             mints the Apple developer token locally

## Runtime secrets

Set with `platform/bin/pb-secret set cymbal-on-website.<KEY>` (value on stdin), then
`platform/bin/pb-provision cymbal-on-website --push-env`. `--push-env` keeps the
`OIDC_*` identity settings that provisioning wrote.

| Key | What |
|---|---|
| `CYMBAL_TOKEN_KEY` | exactly 32 characters; encrypts stored Spotify/Google tokens (`openssl rand -hex 16`) |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | Spotify developer app |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth web client with the YouTube Data API v3 enabled |
| `YOUTUBE_API_KEY` | optional; YouTube reads without spending the owner's token |
| `APPLE_DEVELOPER_TOKEN` | from `tools/apple-dev-token.py`; expires after at most 180 days |
| `CYMBAL_SPOTIFY_METADATA_TRANSFER` | `allowed` to match Spotify-posted songs on the other services; anything else keeps it off |
| `CYMBAL_APPLE_STOREFRONT`, `CYMBAL_SPOTIFY_MARKET` | optional, default `gb` / `GB` |

## Provider setup (owner, once)

Exact callback URLs, also shown in the owner panel:

- Spotify: `https://cymbal-on-website.solhann.net/api/cymbal/oauth/spotify/callback`
- Google: `https://cymbal-on-website.solhann.net/api/cymbal/oauth/youtube/callback`

1. **Spotify**: create an app at developer.spotify.com (Development Mode is enough:
   only the owner's account ever authorises; it needs Spotify Premium), add the
   callback, enable the Web API.
2. **Google**: in Google Cloud, enable YouTube Data API v3, configure the OAuth consent
   screen, create a Web client with the callback. Publish the app ("In production")
   rather than leaving it in Testing, or Google expires the refresh token every seven
   days; the unverified-app warning only affects the owner.
3. **Apple**: in the Apple Developer account, create a Media ID and a MusicKit key,
   then mint the token with `tools/apple-dev-token.py`.
4. Push the secrets, sign in as the owner, and in the owner panel: connect Spotify and
   YouTube, create their playlists, then "Authorise in this browser" for Apple Music
   and create that playlist.

## Tests

    node --test tests/unit
    bash tests/api/run.sh        # local PocketBase on a spare port, mock providers

## Operations

- Backups: `platform/bin/pb-backups cymbal-on-website --local` (offsite needs the
  platform S3 credentials in `pb-secret`).
- Health: `https://cymbal-on-website.solhann.net/api/health`.
