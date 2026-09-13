/* playlists.js — the three playlist links, as plain links.
 *
 * The labels and URLs come from /api/cymbal/playlists. Labels go in as textContent,
 * and only https URLs become links; a playlist that isn't set up yet is plain text. */
(() => {
  "use strict";

  const list = document.getElementById("playlist-links");
  const item = (child) => {
    const li = document.createElement("li");
    li.append(child);
    return li;
  };

  fetch("/api/cymbal/playlists", { headers: { Accept: "application/json" } })
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error("http " + res.status))))
    .then((data) => {
      list.replaceChildren(...data.playlists.map((p) => {
        if (p.url && /^https:\/\/[a-z0-9.-]+\//i.test(p.url)) {
          const a = document.createElement("a");
          a.href = p.url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = p.label;
          return item(a);
        }
        const span = document.createElement("span");
        span.className = "waiting";
        span.textContent = p.label + " (not set up yet)";
        return item(span);
      }));
    })
    .catch(() => {
      const span = document.createElement("span");
      span.textContent = "Couldn't load the playlists. Try again in a moment.";
      list.replaceChildren(item(span));
    });
})();
