// Structural guards that are cheap to check and expensive to get wrong.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.join(__dirname, "..", "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

test("the page never turns data into markup", () => {
  for (const f of ["app.js", "theme.js"]) {
    const src = read(f);
    for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) {
      assert.ok(!src.includes(bad), f + " uses " + bad);
    }
  }
});

test("every page has a CSP and no inline script", () => {
  for (const f of ["index.html", "privacy.html", "terms.html"]) {
    const html = read(f);
    assert.match(html, /http-equiv="Content-Security-Policy"/, f);
    assert.doesNotMatch(html, /script-src[^"]*unsafe-inline/, f);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, f + " has an inline <script>");
    assert.doesNotMatch(html, /\son[a-z]+=/i, f + " has an inline event handler");
  }
});

test("the identity layer is byte-identical to the platform template", (t) => {
  const tpl = path.join(root, "..", "platform", "greenlight", "app-template");
  if (!fs.existsSync(tpl)) return t.skip("platform template not beside this checkout");
  const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  for (const f of ["pb-auth.js", "pb_hooks/identity.pb.js", "pb_migrations/1756540000_identity.js", "vendor/pocketbase.umd.js"]) {
    assert.equal(sha(path.join(root, f)), sha(path.join(tpl, f)), f + " differs from the template");
  }
});

test("hook sources carry no control characters", () => {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".js")) files.push(p);
  });
  walk(path.join(root, "pb_hooks"));
  walk(path.join(root, "pb_migrations"));
  for (const f of files) {
    const ctl = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(8) + String.fromCharCode(11) + String.fromCharCode(12) + String.fromCharCode(14) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]");
    const bad = ctl.test(fs.readFileSync(f, "utf8"));
    assert.ok(!bad, path.relative(root, f));
  }
});

test("every collection is locked at the rule level", () => {
  const src = read("pb_migrations/1757520000_cymbal_schema.js");
  assert.match(src, /listRule: null, viewRule: null, createRule: null, updateRule: null, deleteRule: null/);
  const made = src.match(/name: "[a-z_]+",\s*\n\s*fields:/g) || [];
  const locked = src.match(/\}, locked\)\);/g) || [];
  assert.equal(locked.length, 6);
  assert.ok(made.length === 0 || made.length === locked.length);
});
