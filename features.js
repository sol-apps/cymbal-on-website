/* features.js — which new bits of Cymbal are switched on, and for whom.
 *
 *   "owner"    only while the owner is signed in: try it on the live site first
 *   "members"  anyone signed in (anyone can make an account)
 *   "all"      everyone, signed in or not
 *   "off"      nobody
 *
 * Releasing something to everyone is changing its word here to "all". Anything a
 * feature changes on the server is still checked there; this file only decides what
 * the page draws.
 */
const FEATURES = {
  stickerMotion: "members",   // stickers lift a little when picked up and press down when stuck
  smallStickers: "members",   // stickers 20% smaller
  stickerButton: "members",   // a button on each post, showing the newest stickers, next to + COMMENT
  plusComment: "members",     // a smaller "+ COMMENT" button
  openComments: "members",    // comments shown on every post, folded after three
  miscPage: "members",        // misc.html: your picture, playlists, theme, most reacts (and the
                              // owner panel); a MISC button replaces DARK and the playlist row
  listenCount: "members",     // how many browsers played each post
  accountAvatars: "members",  // no empty avatar: a picture, a letter for an account, or nothing
  profilePics: "members",     // anyone can set a picture (on misc.html); their posts show it
  compactTop: "members",      // a shorter top bar and composer on phones
  compactCards: "members",    // tighter posts: remove at the top right, no source label or
                              // playlist chips, smaller caption and title, flatter buttons
};
