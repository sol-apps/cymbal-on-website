/* theme.js — the shared solhann.net light/dark preference ("solhann_theme").
 * Loaded synchronously in <head> so the page never flashes the wrong theme. */
(function () {
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem("solhann_theme"); } catch (_) { /* storage blocked */ }
  var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", saved === "dark" || saved === "light" ? saved : (prefersDark ? "dark" : "light"));

  function sync(btn) {
    var dark = root.getAttribute("data-theme") === "dark";
    btn.textContent = dark ? "LIGHT" : "DARK";
    btn.setAttribute("aria-label", dark ? "Switch to the light theme" : "Switch to the dark theme");
  }

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("theme");
    if (!btn) return;
    sync(btn);
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("solhann_theme", next); } catch (_) { /* storage blocked */ }
      sync(btn);
    });
  });
})();
