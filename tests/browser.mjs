/* browser.mjs — run the shipped page in a real browser.
   This is the only test that exercises the DOM layer, WebCrypto/CompressionStream on
   file://, CORS from a file:// origin, the button wiring, and the proof file the UI
   produces (which is then re-verified offline through the pasted-beacon path).
   Usage: node tests/browser.mjs   (needs Chrome or Edge, or set CHROME_PATH) */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

const L = createRequire(import.meta.url)("../src/engine.js");

const CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
].filter(Boolean);
const exe = CANDIDATES.find((p) => existsSync(p));
if (!exe) {
  console.log("browser.mjs: no Chrome/Edge found — skipped (set CHROME_PATH to run it)");
  process.exit(0);
}

const slot = mkdtempSync(path.join(process.env.TEMP || tmpdir(), "lotto-browser-"));
const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
if (!html.includes("</body>")) throw new Error("dist/index.html has no </body>");

function open(code, probe, budget) {
  const page = path.join(slot, "page-" + Math.abs(code.length * 7 + budget) + ".html");
  writeFileSync(page, html.replace("</body>", probe + "</body>"));
  const url = "file:///" + page.replace(/\\/g, "/") + "?t=" + encodeURIComponent(code);
  return execFileSync(exe, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-extensions",
    "--no-first-run", "--no-default-browser-check", "--user-data-dir=" + path.join(slot, "chrome"),
    "--virtual-time-budget=" + budget, "--dump-dom", url
  ], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024, timeout: 300000 }).toString();
}
const probeOf = (dom) => (/<div id="probe">([\s\S]*?)<\/div>/.exec(dom) || [, ""])[1];
const fail = [];
const notes = [];

try {
  /* ------------------------------------------------------------------ phase A
     a shared link, opened cold: load the code, draw from the real beacon, render,
     build the shareable link, produce a proof file, then verify it as a participant. */
  const names = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Edsger Dijkstra", "Barbara Liskov", "Tony Hoare"];
  const round = L.roundOf(Math.floor(Date.now() / 1000)) - 4;
  const { code } = await L.encodeToken({ type: "selection", k: 3, names, createdRound: round - 200, drawRound: round });
  const lot = await L.decodeToken(code);
  const tokenHash = await L.tokenHash(lot.raw);

  let beacon = await L.fetchBeacon(round);
  for (let i = 0; i < 12 && !beacon.ok; i++) { await new Promise((r) => setTimeout(r, 4000)); beacon = await L.fetchBeacon(round); }
  if (!beacon.ok) {
    console.log("browser.mjs: relays unavailable (" + beacon.relays.map((r) => r.status).join(", ") + ") — skipped");
    process.exit(0);
  }
  const expected = await L.run(lot, beacon);
  const expectedWinners = expected.order.map((i) => names[i]);

  const PROBE_A = `
<div id="probe">PENDING</div>
<script>
(function () {
  var t0 = Date.now(), log = [], errors = [], finished = false, clicked = false;
  function mark(s) {
    if (finished) return;
    if (s === "VERIFIED" || s === "NOFACTS") finished = true;
    document.getElementById("probe").textContent =
      "PROBE|" + s + "|" + (Date.now() - t0) + "|" + errors.join(" ~ ") + "|" + log.join(";");
  }
  window.addEventListener("error", function (e) { errors.push("JSERROR:" + e.message); });
  window.addEventListener("unhandledrejection", function (e) {
    errors.push("REJECT:" + ((e.reason && e.reason.message) || e.reason));
  });
  /* catch the proof file the UI hands to the browser */
  var realCreate = URL.createObjectURL;
  URL.createObjectURL = function (blob) {
    if (blob && blob.text) blob.text().then(function (t) { window.__proof = t; });
    return realCreate.call(URL, blob);
  };
  var step = 0;
  var iv = setInterval(function () {
    if (finished) { clearInterval(iv); return; }
    var facts = document.getElementById("facts").innerHTML;
    if (facts.length < 50) return;
    if (step === 0) {
      if (!/token hash/.test(facts)) { clearInterval(iv); mark("NOFACTS"); return; }
      log.push("facts-ok");
      document.getElementById("drawbtn").click();
      log.push("drew");
      step = 1;
      return;
    }
    if (step === 1) {
      if (document.getElementById("result").innerHTML.length < 50) return;
      log.push("rendered");
      document.getElementById("link").click();
      log.push("linklen=" + (document.getElementById("linkbox").value || "").length);
      document.getElementById("proofcopy").click();
      document.getElementById("proofdl").click();
      log.push("proof");
      document.getElementById("verifybtn").click();
      log.push("verify-clicked");
      step = 2;
      return;
    }
    var verdict = document.getElementById("vout").innerHTML;
    if (window.__proof && !document.getElementById("proofjson")) {
      var pre = document.createElement("pre");
      pre.id = "proofjson";
      pre.textContent = window.__proof;
      document.body.appendChild(pre);
      log.push("prooflen=" + window.__proof.length);
    }
    if (/Verified/.test(verdict) && document.getElementById("proofjson")) {
      clearInterval(iv);
      log.push("verdict");
      mark("VERIFIED");
    }
  }, 250);
  setTimeout(function () { if (!finished) mark("TIMEOUT:" + (document.getElementById("banner").textContent || "silent")); }, 60000);
}());
</script>`;

  const domA = open(code, PROBE_A, 60000);
  const probeA = probeOf(domA);
  const hash = (/result hash ([0-9a-f]{64})/.exec(domA) || [])[1];
  const vout = (/<div id="vout">([\s\S]*?)<\/div>/.exec(domA) || [, ""])[1];
  const linklen = (/linklen=(\d+)/.exec(probeA) || [, "0"])[1];

  if (!/PROBE\|VERIFIED/.test(probeA)) fail.push("the page never finished drawing and verifying: " + probeA.slice(0, 600));
  if (/JSERROR|REJECT/.test(probeA)) fail.push("javascript errors surfaced: " + probeA.slice(0, 600));
  if (!domA.includes(tokenHash)) fail.push("the token hash never reached the page");
  if (hash !== expected.hash) fail.push("the browser drew " + (hash || "nothing") + " but the engine says " + expected.hash);
  for (const w of expectedWinners) if (!domA.includes(w)) fail.push("winner " + w + " is missing from the page");
  if (!/10-minute rule/.test(domA)) fail.push("the 10-minute rule is not displayed");
  if (Number(linklen) < 100) fail.push("the shareable link was not built");
  if (!/Verified/.test(vout)) fail.push("the verify panel did not report Verified");
  notes.push("draw + verify in the page: hash " + (hash || "").slice(0, 16) + "… · link " + linklen + " chars");

  /* the proof file the UI produced must verify offline, through the pasted-beacon path */
  const rawProof = (/<pre id="proofjson">([\s\S]*?)<\/pre>/.exec(domA) || [, ""])[1]
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  if (!rawProof) {
    fail.push("the page never produced a proof file");
  } else {
    let proof = null;
    try { proof = JSON.parse(rawProof); } catch (e) { fail.push("the proof file is not valid JSON: " + e.message); }
    if (proof) {
      if (proof.token !== code) fail.push("the proof does not carry the token");
      if (proof.result.hash !== expected.hash) fail.push("the proof result hash is wrong");
      if (proof.beacon.randomness !== beacon.randomness || proof.beacon.signature !== beacon.signature) {
        fail.push("the proof does not carry the real beacon");
      }
      const pasted = L.parseBeacon(rawProof);
      const offline = await L.verify(proof.token, pasted, proof.result.hash);
      if (!offline.ok) fail.push("the proof file does not verify offline: " + JSON.stringify(offline.checks.filter((c) => !c.ok)));
      if (offline.result && offline.result.hash !== expected.hash) fail.push("the offline recomputation disagrees");
      notes.push("proof file (" + rawProof.length + " bytes) re-verified offline: " + (offline.ok ? "ok" : "FAILED"));
    }
  }

  /* ------------------------------------------------------------------ phase B
     a lottery whose time has not come yet: the button must be locked and a clock shown. */
  const future = L.roundOf(Math.floor(Date.now() / 1000)) + 400;
  const futureCode = (await L.encodeToken({ type: "ranking", names: names, createdRound: future - 200, drawRound: future })).code;
  const PROBE_B = `
<div id="probe">PENDING</div>
<script>
(function () {
  var errors = [];
  window.addEventListener("error", function (e) { errors.push("JSERROR:" + e.message); });
  window.addEventListener("unhandledrejection", function (e) {
    errors.push("REJECT:" + ((e.reason && e.reason.message) || e.reason));
  });
  var iv = setInterval(function () {
    var c = document.getElementById("countdown");
    if (!c || c.textContent.indexOf(" in ") < 0) return;
    clearInterval(iv);
    document.getElementById("probe").textContent = "PROBE|READY|" + errors.join(" ~ ");
  }, 100);
}());
</script>`;
  const domB = open(futureCode, PROBE_B, 12000);
  const probeB = probeOf(domB);
  const clockB = ((/<p class="hint" id="countdown">([\s\S]*?)<\/p>/.exec(domB) || [])[1] || "").trim();
  const btnB = (/<button id="drawbtn"[^>]*>/.exec(domB) || [])[0] || "";
  if (!/PROBE\|READY/.test(probeB)) fail.push("the future lottery never showed a clock: " + probeB.slice(0, 200));
  if (/JSERROR|REJECT/.test(probeB)) fail.push("javascript errors on the future page: " + probeB.slice(0, 200));
  if (!/ in \d/.test(clockB)) fail.push("the countdown does not show the time remaining: " + clockB);
  if (!/published at \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/.test(clockB)) fail.push("the countdown does not name the beacon time: " + clockB);
  if (!/\bdisabled\b/.test(btnB)) fail.push("the draw button is not locked before the lottery time: " + btnB);
  if (!/<div id="result"><\/div>/.test(domB)) fail.push("a lottery that has not happened yet already shows a result");
  notes.push("future lottery: " + clockB.replace(/\s+/g, " ").slice(0, 130));
} finally {
  rmSync(slot, { recursive: true, force: true });
}

console.log("browser.mjs via " + path.basename(exe));
for (const n of notes) console.log("  " + n);
if (fail.length) {
  console.error("\nFAILED:\n - " + fail.join("\n - "));
  process.exit(1);
}
console.log("  OK — the shipped page loads a shared link, draws from drand, verifies, and hands out a proof that checks out offline");
