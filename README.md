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

- Whatever link someone posts is kept as is.
- Every minute, a background job looks the song up and finds it on the other two
  services: first by ISRC, then MusicBrainz, then an exact title/artist/version/length match.
- If nothing matches exactly, it adds the closest candidate anyway and flags it under
  "Guessed, to check" in the owner panel. It won't swap a live version, remix or
  cover for the original, or pick a different artist.
- If there's nothing close enough, it shows up under "Needs a look", and the owner
  pastes the right link.
- Each playlist gets a song once, however many times it's posted.
- Spotify and YouTube update in the background. Apple Music only adds songs while the
  owner has Cymbal open in a browser they've authorised.
