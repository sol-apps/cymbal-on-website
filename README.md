---
solhann_app: true
slug: cymbal-on-website
title: Cymbal on Website
description: Music sharing forum + playlists
---

# Cymbal on Website

Music sharing forum + playlists.

https://cymbal-on-website.solhann.net

## How a post reaches three playlists

- Friends can post Spotify, Apple Music, YouTube or Bandcamp links. Bandcamp has no
  playlists, so a Bandcamp post goes on the other three like any other song.
- Whatever link someone posts is kept as is.
- Every minute, a background job looks the song up and finds it on the other two
  services: first by ISRC, then MusicBrainz, then an exact title/artist/version/length match.
- If nothing matches exactly, it adds the closest candidate anyway and flags it under
  "Guessed, to check" in the owner panel. It won't swap a live version, remix or
  cover for the original, or pick a different artist.
- If there's nothing close enough, it shows up under "Needs a look" with the closest
  thing it found. The owner can use that, paste the right link, or dismiss it when the
  song just isn't on that service.
- Each playlist gets a song once, however many times it's posted.
- Spotify and YouTube update in the background. Apple Music only adds songs while the
  owner has Cymbal open in a browser they've authorised.

## Accounts

Anyone can make an account (SIGN IN, then "New here? Make an account": a name, an
email and a password) and stays signed in for a week. Posting and commenting still
need no account. Signed-in people get the new features below and can place stickers.
Only the owner can remove posts and comments, and only the owner has the owner panel,
sticker uploads and Apple Music. The owner is the one account given role "admin" in
the PocketBase dashboard; signing up never makes one.

## Stickers

Everyone sees the stickers on a post. Anyone signed in can place them: a sticker
button on each post (or, with that off, a red heart and a silver star in the bottom
corner). Pick one up (drag
it, or tap it and then tap where it goes) and let go on a post to stick it there.
It's one sticker each per post, so a second one takes the first one's place. A placed
sticker can be picked up again and moved; dropping it anywhere off a post takes it off.

## Trying things out first

New features can be switched on for the owner only, for anyone signed in, or for
everyone. `features.js` lists each one as `"owner"`, `"members"`, `"all"` or `"off"`;
changing a word there is how a feature goes out further. Anything a feature changes on
the server is still checked there, whatever that file says.

For anyone signed in for now: sticker animation, smaller stickers, a sticker button on each post
(showing the newest stickers), a smaller + COMMENT button, comments shown on every post
(folded after three), listen counts, tighter posts and top bar on phones (remove at the
top right, no source label or playlist chips), no empty avatars, profile pictures, and
the Misc page.

`misc.html` is for everyone: a picture and name for this browser, the playlists, the
light/dark switch and sticker uploads. Signed in as the owner it also has the posts with
the most reacts (below the stickers) and the owner panel. A picture belongs to the browser that set it, like
a post does, and shows on that browser's posts.

Listens are counted for everyone even while only signed-in people see the numbers: clicking
into a post's player, or opening its song link, counts once per browser per post.
