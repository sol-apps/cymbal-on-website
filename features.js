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
  stickerMotion: "all",       // stickers lift a little when picked up and press down when stuck
  smallStickers: "all",       // stickers 20% smaller
  stickerButton: "all",       // a button on each post, showing the newest stickers, next to + COMMENT
  plusComment: "all",         // a smaller "+ COMMENT" button
  openComments: "all",        // comments shown on every post, folded after three
  miscPage: "all",            // misc.html: your picture, playlists, theme, most reacts (and the
                              // owner panel); a MISC button replaces DARK and the playlist row
  listenCount: "all",         // how many browsers played each post
  accountAvatars: "all",      // no empty avatar: a picture, a letter for an account, or nothing
  profilePics: "all",         // anyone can set a picture (on misc.html); their posts show it
  compactTop: "all",          // a shorter top bar and composer on phones
  compactCards: "all",        // tighter posts: remove at the top right, no source label or
                              // playlist chips, smaller caption and title, flatter buttons
  pillComments: "all",        // the comment box looks like a message box: one line that grows,
                              // a small send button, and a small name box only when signed out
  altLinks: "all",            // under each post, blue links to the song on the other services
                              // (only the ones Cymbal has found); replaces the playlist chips
  signInOnMisc: "all",        // no sign-in in the top bar: signing in, making an account and
                              // signing out all happen on misc.html
  outPics: "all",             // signed out, a browser can set its own picture on misc.html; the
                              // posts it makes show it
  miscTidy: "all",            // a tidier Misc: you first, sign-in folded to two buttons, a proper
                              // file button, no empty gaps, no footer link
  outBubble: "all",           // signed out, posts get the same comment bubble and sticker row as
                              // signed in (needs stickerButton and openComments on for them too).
                              // Only "all" reaches anyone signed out, so "members" or "owner"
                              // changes nothing
};
