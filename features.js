/* features.js — which new bits of Cymbal are switched on, and for whom.
 *
 *   "owner"  only while the owner is signed in: try it on the live site first
 *   "all"    everyone
 *   "off"    nobody
 *
 * Releasing something to everyone is changing its word here to "all". Anything a
 * feature changes on the server is still checked there (util.requireOwner); this file
 * only decides what the page draws.
 */
const FEATURES = {
  stickerMotion: "owner",   // stickers slap down, lift when picked up, wiggle on hover
  smallStickers: "owner",   // stickers 20% smaller
  stickerButton: "owner",   // a STICKER button on each post, next to + COMMENT
  plusComment: "owner",     // a smaller "+ COMMENT" button
  openComments: "owner",    // comments shown on every post, folded after three
  settingsPage: "owner",    // owner panel moves to settings.html
  listenCount: "owner",     // how many browsers played each post
  accountAvatars: "owner",  // letter avatars only on posts made from an account
};
