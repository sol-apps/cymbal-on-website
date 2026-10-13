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
  stickerButton: "owner",   // a button on each post, showing the newest stickers, next to + COMMENT
  plusComment: "owner",     // a smaller "+ COMMENT" button
  openComments: "owner",    // comments shown on every post, folded after three
  miscPage: "owner",        // misc.html: your picture, playlists, theme, most reacts (and the
                            // owner panel); a MISC button replaces DARK and the playlist row
  listenCount: "owner",     // how many browsers played each post
  accountAvatars: "owner",  // no empty avatar: a picture, a letter for an account, or nothing
  profilePics: "owner",     // anyone can set a picture (on misc.html); their posts show it
  compactTop: "owner",      // a shorter top bar and composer on phones
  compactCards: "owner",    // tighter posts: remove at the top right, no source label or
                            // playlist chips, smaller caption and title, flatter buttons
};
