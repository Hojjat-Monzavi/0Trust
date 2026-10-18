/* dist.test.mjs — test the artifact that actually ships, not just the sources.
   Catches: external resources, DOM ids that app.js expects but the HTML lacks,
   and any divergence between dist/index.html and the engine the tests exercise. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";

const path = new URL("../dist/index.html", import.meta.url);
const html = readFileSync(path, "utf8");
const L = createRequire(import.meta.url)("../src/engine.js");
const V = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));

function block(marker) {
  const open = "//<" + marker + ">", close = "//</" + marker + ">";
  const a = html.indexOf(open), b = html.indexOf(close);
  assert.ok(a >= 0 && b > a, marker + " block missing from dist/index.html");
  return html.slice(a + open.length, b);
}

test("the page is one self-contained file", () => {
  assert.ok(!/<script[^>]+\bsrc\s*=/i.test(html), "an external script");
  assert.ok(!/<link\b/i.test(html), "an external stylesheet or icon");
  assert.ok(!/<img\b|<iframe\b|<embed\b|<object\b/i.test(html), "an external embedded resource");
  assert.ok(!/@import/i.test(html), "a CSS @import");
  assert.ok(!/url\(\s*["']?https?:/i.test(html), "a CSS url() pointing off-page");
  assert.equal(html.split("<style>").length, 2, "exactly one inline stylesheet");
  assert.equal(html.split("<script>").length, 2, "exactly one inline script");
  assert.equal(html.split("</script>").length, 2);
  assert.ok(html.length < 200000, "the page is unexpectedly large: " + html.length + " bytes");
});

test("the shipped engine is the one that was tested", async () => {
  const engine = block("engine");
  const shipped = new Function(engine + "\nreturn LOTTO;")();
  assert.equal(shipped.TAG, L.TAG);
  for (const v of V) {
    const lot = await shipped.decodeToken(v.code);
    const res = await shipped.run(lot, { round: v.drawRound, randomness: v.draws["beacon-a"].randomness });
    assert.equal(res.hash, v.draws["beacon-a"].hash, v.name);
  }
  const a = await L.encodeToken({ type: "selection", k: 2, names: ["a", "b", "c"], createdRound: 1, drawRound: 201 });
  const b = await shipped.encodeToken({ type: "selection", k: 2, names: ["a", "b", "c"], createdRound: 1, drawRound: 201 });
  assert.equal(a.code, b.code, "the shipped engine must compress identically");
});

test("every element app.js reaches for exists in the markup", () => {
  const app = block("app");
  const ids = new Set();
  for (const m of app.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)) ids.add(m[1]);
  assert.ok(ids.size > 30, "only " + ids.size + " ids found — did app.js change shape?");
  const missing = [...ids].filter((id) => !html.includes('id="' + id + '"'));
  assert.deepEqual(missing, [], "app.js references ids that are not in the page");
  for (const id of ids) {
    const uses = html.split('id="' + id + '"').length - 1;
    assert.equal(uses, 1, id + " is defined " + uses + " times");
  }
  assert.ok(html.includes("data-add="), "the quick date buttons are gated on data-add");
  assert.ok(html.includes('id="names"') && html.includes('id="weights"'));
});

test("the specification and the safety text ship with the page", () => {
  for (const needle of [
    "Frozen specification", "Fisher–Yates", "deflate-raw", "base64url",
    "10-minute rule", "SHA256(signature)", "quicknet", "52db9ba7"
  ]) {
    assert.ok(html.includes(needle), "the page should mention " + JSON.stringify(needle));
  }
  assert.ok(html.includes(L.CHAIN.hash), "the chain hash is missing");
  assert.ok(html.includes(L.CHAIN.pub), "the public key is missing");
  assert.ok(/at least 10 minutes before/i.test(html), "the publish-before-the-draw warning is missing");
});

test("the artifact on disk is built from the sources on disk (no stale dist)", () => {
  const srcApp = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  const between = srcApp.slice(srcApp.indexOf("//<app>") + "//<app>".length, srcApp.indexOf("//</app>"));
  assert.equal(block("app"), between, "dist/index.html is stale — run: npm run build");
  const spec = readFileSync(new URL("../src/spec.html", import.meta.url), "utf8").trimEnd();
  assert.ok(html.includes(spec), "dist/index.html is stale (the spec) — run: npm run build");
  const style = readFileSync(new URL("../src/style.css", import.meta.url), "utf8").trimEnd();
  assert.ok(html.includes(style), "dist/index.html is stale (the stylesheet) — run: npm run build");
});

test("the published copy is the tested copy (GitHub Pages serves docs/)", () => {
  const pub = readFileSync(new URL("../docs/index.html", import.meta.url), "utf8");
  assert.equal(pub, html, "docs/index.html differs from dist/index.html — run: npm run build");
  assert.ok(existsSync(new URL("../docs/.nojekyll", import.meta.url)), "docs/.nojekyll is missing — Jekyll would process the page");
});

test("the page loads without a server (file://) and without network for verification", () => {
  assert.ok(!/location\.protocol\s*===/.test(html), "no protocol gating");
  assert.ok(html.includes("https://api.drand.sh"), "the default relay list is missing");
  const relays = [...html.matchAll(/https:\/\/[a-z0-9.-]*drand[a-z0-9.\/-]*/g)].map((m) => m[0]);
  assert.ok(relays.length >= 3, "expected three relays, found " + JSON.stringify(relays));
});
