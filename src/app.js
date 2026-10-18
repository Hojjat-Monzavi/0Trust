//<app>
/* app.js — the interface. Every piece of lottery maths lives in engine.js. */
(function () {
  "use strict";
  var L = LOTTO;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var group = function (n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, "\u2009"); };
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var MAXROWS = 500;

  var S = { lot: null, code: "", tokenHash: "", res: null, beacon: null, sizes: null, timer: null, busy: false };

  /* ---------------- small helpers ---------------- */

  function msg(text, kind) {
    var b = $("banner");
    b.textContent = text || "";
    b.className = "banner " + (kind || "info");
    b.hidden = !text;
  }
  function table(rows, head) {
    var h = head ? "<thead><tr>" + head.map(function (x) { return "<th>" + esc(x) + "</th>"; }).join("") + "</tr></thead>" : "";
    return "<table>" + h + "<tbody>" + rows.map(function (r) {
      return "<tr>" + r.map(function (c, i) { return "<td" + (i ? ' class="n"' : "") + ">" + esc(c) + "</td>"; }).join("") + "</tr>";
    }).join("") + "</tbody></table>";
  }
  function capped(rows, head) {
    var cut = rows.slice(0, MAXROWS);
    return table(cut, head) +
      (rows.length > cut.length ? '<p class="hint">showing the first ' + MAXROWS + " of " + group(rows.length) + "</p>" : "");
  }
  function hms(sec) {
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60, p = function (x) { return (x < 10 ? "0" : "") + x; };
    return (h ? h + ":" + p(m) : m + "") + ":" + p(s);
  }
  function localInput(t) {
    return new Date(t * 1000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  function legacyCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* nothing else to try */ }
    document.body.removeChild(ta);
  }
  /* never rejects: a denied clipboard must not surface as an unhandled rejection */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(null, function () { legacyCopy(text); });
    }
    legacyCopy(text);
    return Promise.resolve();
  }
  function download(name, text) {
    var a = document.createElement("a"), url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.href = url; a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  /* ---------------- form ---------------- */

  var KDEF = {
    selection: { label: "Winners", def: 3, hint: "How many winners to pick. Without replacement each participant can win once." },
    ranking: { label: "—", def: null, hint: "Ranking always covers every participant." },
    distribution: { label: "Groups", def: 2, hint: "How many groups the field is split into." },
    allocation: { label: "Units to share out", def: 10, hint: "How many units (points, seats, coins) to divide up." }
  };

  function syncKind() {
    var kind = $("kind").value, d = KDEF[kind];
    $("krow").hidden = kind === "ranking";
    $("klabel").textContent = d.label;
    $("khint").textContent = d.hint;
    $("replrow").hidden = kind !== "selection";
    if ($("k").dataset.kind !== kind) { $("k").value = d.def === null ? "" : d.def; $("k").dataset.kind = kind; }
  }

  function readWhen() {
    var t = Math.floor(new Date($("when").value).getTime() / 1000);
    if (!Number.isFinite(t)) throw new Error("pick a draw time");
    return t;
  }
  function previewRound() {
    try {
      var t = readWhen(), now = Math.floor(Date.now() / 1000);
      var c = L.roundOf(now), r = L.roundOf(t), d = r - c;
      $("wheninfo").innerHTML = "draw round <b>" + group(r) + "</b> · beacon published <b>" + esc(L.utc(L.timeOfRound(r))) + "</b> · " +
        (d >= L.RULE
          ? '<span class="ok">' + d + " rounds (" + Math.round(d * L.CHAIN.period / 60) + " min) after creation — the 10-minute rule is met</span>"
          : '<span class="bad">only ' + d + " rounds ahead — the earliest allowed draw time is " + esc(L.utc(L.timeOfRound(c + L.RULE))) + "</span>");
    } catch (e) { $("wheninfo").textContent = e.message; }
  }

  function parseNames(text) {
    var lines = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
    var stripped = false;
    if (lines.length && lines.every(function (l) { return /^\d+[.)]\s+\S/.test(l); })) {
      lines = lines.map(function (l) { return l.replace(/^\d+[.)]\s+/, "").trim(); }).filter(function (s) { return s.length; });
      stripped = true;
    }
    return { names: lines, stripped: stripped };
  }
  function parseWeights(text, n) {
    var lines = text.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
    if (!lines.length) return null;
    var w = lines.map(function (s) {
      if (!/^\d+$/.test(s)) throw new Error("weights must be whole numbers, one per line");
      var v = Number(s);
      if (!Number.isSafeInteger(v) || v > 4294967295) throw new Error("each weight must be between 0 and 4294967295");
      return v;
    });
    if (w.length !== n) throw new Error("there are " + n + " participants but " + w.length + " weights");
    return w;
  }

  function countLabel(lot) {
    return lot.type === "selection" ? "winners" : lot.type === "ranking" ? "ranked" : lot.type === "distribution" ? "groups" : "units";
  }
  function kindLabel(lot) {
    return { selection: "selection", ranking: "ranking", distribution: "distribution into groups", allocation: "proportional allocation" }[lot.type] +
      (lot.replacement ? " · with replacement" : "") + (lot.weights ? " · weighted" : "");
  }

  /* ---------------- views ---------------- */

  function show() {
    var ids = Array.prototype.slice.call(arguments);
    ["secCreate", "secToken", "secRun", "secVerify"].forEach(function (id) { $(id).hidden = ids.indexOf(id) < 0; });
    if (ids.indexOf("secRun") >= 0) armDraw(); else clearInterval(S.timer);
  }

  async function compile() {
    $("cerr").textContent = "";
    try {
      var parsed = parseNames($("names").value);
      if (!parsed.names.length) throw new Error("add at least one participant");
      var weights = parseWeights($("weights").value, parsed.names.length);
      var kind = $("kind").value;
      var now = Math.floor(Date.now() / 1000);
      var createdRound = L.roundOf(now);
      var drawRound = L.roundOf(readWhen());
      var out = await L.encodeToken({
        type: kind,
        replacement: kind === "selection" && $("repl").checked,
        createdRound: createdRound,
        drawRound: drawRound,
        k: kind === "ranking" ? parsed.names.length : Number($("k").value),
        names: parsed.names, weights: weights
      });
      S.lot = L.unpack(out.raw);
      S.code = out.code;
      S.sizes = out.sizes;
      S.tokenHash = await L.hashHex(S.lot.raw);
      S.res = null; S.beacon = null;
      renderToken(parsed.stripped);
      renderFacts();
      $("vcode").value = S.code;
      $("vbeacon").value = "";
      $("vout").innerHTML = "";
      $("result").innerHTML = ""; $("relays").innerHTML = ""; $("proofbtns").hidden = true;
      /* the address bar is a convenience, so a very long token or a picky browser must not break the flow */
      try {
        if (S.code.length < 8000) history.replaceState(null, "", location.href.split(/[?#]/)[0] + "?t=" + encodeURIComponent(S.code));
      } catch (e) { /* ignore */ }
      show("secCreate", "secToken", "secRun");
      msg("");
    } catch (e) {
      $("cerr").textContent = e.message;
    }
  }

  function renderToken(stripped) {
    var lot = S.lot, d = lot.drawRound - lot.createdRound;
    $("code").value = S.code;
    $("size").innerHTML = group(lot.n) + " participants · " + group(S.sizes.raw) + " bytes packed → " +
      group(S.sizes.deflated) + " deflated → " + group(S.sizes.code) + " characters in the code" +
      (stripped ? " · a numbered list was detected and the numbers were stripped" : "");
    $("rule").innerHTML = "Publish this code, or the link to it, somewhere public <b>at least 10 minutes before " +
      esc(L.utc(L.timeOfRound(lot.drawRound))) + "</b> (round " + group(lot.drawRound) + ") and leave it there. " +
      (d >= L.RULE ? "That deadline is met (draw round is " + d + " rounds after creation)."
        : '<span class="bad">This code breaks the 10-minute rule (only ' + d + " rounds).</span>") +
      " Anyone who has the code and that beacon can redo the draw themselves.";
  }

  function renderFacts() {
    var lot = S.lot, d = lot.drawRound - lot.createdRound;
    $("facts").innerHTML = '<div class="card">' + table([
      ["lottery", kindLabel(lot)],
      ["participants", group(lot.n) + (lot.weights ? " (weights stored)" : "")],
      [countLabel(lot), group(lot.k)],
      ["token hash", S.tokenHash],
      ["created round", group(lot.createdRound)],
      ["draw round", group(lot.drawRound) + " · " + L.utc(L.timeOfRound(lot.drawRound))],
      ["10-minute rule", d >= L.RULE ? "met (Δ " + d + " rounds)" : "violated (Δ " + d + " rounds)"]
    ]) + "</div>";
  }

  function armDraw() {
    clearInterval(S.timer);
    S.timer = null;
    if (!S.lot) return;
    var tick = function () {
      var now = Math.floor(Date.now() / 1000), t = L.timeOfRound(S.lot.drawRound), left = t - now;
      $("drawbtn").disabled = left > 0 || S.busy;
      $("countdown").textContent = left > 0
        ? "The beacon for round " + group(S.lot.drawRound) + " is published at " + L.utc(t) + " — in " + hms(left) + "."
        : "Round " + group(S.lot.drawRound) + " was published at " + L.utc(t) + " — the beacon is available now.";
      if (left <= 0) { clearInterval(S.timer); S.timer = null; }
      return left;
    };
    /* only a future draw needs a ticking clock; a past one is checked once */
    if (tick() > 0) S.timer = setInterval(tick, 1000);
  }

  /* ---------------- the draw ---------------- */

  async function renderRelays(b) {
    var rows = b.relays.map(function (r) { return [r.host.replace(/^https:\/\//, ""), r.status]; });
    var extra = '<p class="bad">No relay could supply round ' + group(b.round) + ".</p>";
    if (b.ok) {
      var sha = await L.hashHex(L.fromHex(b.signature)) === b.randomness;
      extra = '<p class="mono small">round ' + group(b.round) + "<br>randomness " + esc(b.randomness) + "<br>signature " + esc(b.signature) + "</p>" +
        '<p class="' + (b.agree === b.total ? "ok" : "warn") + '">' + b.agree + " of " + b.total +
        " relays returned identical round data · SHA256(signature) == randomness: " + (sha ? "yes" : "NO") +
        (b.agree < b.total ? " · the other relays were unreachable or disagreed" : "") + "</p>";
    } else if (b.notYet) {
      extra = '<p class="warn">Round ' + group(b.round) + " is not published yet.</p>";
    }
    $("relays").innerHTML = table(rows, ["relay", "status"]) + extra;
  }

  async function doDraw() {
    if (S.busy) return;
    S.busy = true;
    var btn = $("drawbtn");
    btn.disabled = true;
    try {
      msg("Asking " + L.CHAIN.relays.length + " drand relays for round " + group(S.lot.drawRound) + "…");
      var t0 = Date.now();
      var b = await L.fetchBeacon(S.lot.drawRound);
      await renderRelays(b);
      while (!b.ok && Date.now() - t0 < 120000) {
        await sleep(L.CHAIN.period * 1000);
        msg("Waiting for the beacon of round " + group(S.lot.drawRound) + "… " + Math.round((Date.now() - t0) / 1000) + " s");
        b = await L.fetchBeacon(S.lot.drawRound);
        await renderRelays(b);
      }
      if (!b.ok) throw new Error(b.notYet
        ? "the beacon for round " + group(S.lot.drawRound) + " is still not published"
        : "the relays did not agree on round " + group(S.lot.drawRound) + " (" + b.agree + " of " + b.total + ") — treat this beacon as untrusted");
      S.beacon = b;
      S.res = await L.run(S.lot, b);
      renderResult();
      msg("Drawn from drand round " + group(b.round) + " with " + b.agree + " of " + b.total + " relays in agreement.", "ok");
    } catch (e) {
      msg(e.message, "bad");
    } finally {
      S.busy = false;
      btn.disabled = false;
    }
  }

  function renderResult() {
    var lot = S.lot, res = S.res, body = "";
    if (lot.type === "selection" || lot.type === "ranking") {
      body = capped(res.order.map(function (ix, i) { return [String(i + 1), lot.names[ix]]; }), [lot.type === "ranking" ? "rank" : "place", "participant"]);
    } else if (lot.type === "distribution") {
      var G = lot.k, n = lot.n, base = Math.floor(n / G), rem = n % G, p = 0;
      body = "";
      for (var g = 0; g < G; g++) {
        var s = base + (g < rem ? 1 : 0), mem = res.order.slice(p, p + s);
        p += s;
        body += "<h3>Group " + (g + 1) + ' <span class="mut">(' + mem.length + ")</span></h3><div class=\"members\">" +
          mem.map(function (ix) { return esc(lot.names[ix]); }).join(", ") + "</div>";
      }
    } else {
      body = capped(lot.names.map(function (nm, i) { return [nm, lot.weights ? String(lot.weights[i]) : "1", String(res.shares[i])]; }), ["participant", "weight", "units"]);
    }
    $("result").innerHTML = '<div class="card">' + body + "</div>" +
      '<p class="mono small">result hash ' + esc(res.hash) + "</p>";
    $("proofbtns").hidden = false;
  }

  function proof() {
    var lot = S.lot;
    return JSON.stringify({
      engine: L.TAG,
      created: new Date().toISOString(),
      token: S.code,
      tokenHash: S.tokenHash,
      lottery: {
        kind: lot.type, replacement: lot.replacement, weighted: !!lot.weights,
        n: lot.n, k: lot.k, createdRound: lot.createdRound, drawRound: lot.drawRound,
        drawTimeUTC: L.utc(L.timeOfRound(lot.drawRound))
      },
      beacon: {
        chain: L.CHAIN.name, chainHash: L.CHAIN.hash, scheme: L.CHAIN.scheme,
        round: S.beacon.round, randomness: S.beacon.randomness, signature: S.beacon.signature
      },
      relays: S.beacon.relays.map(function (r) { return { host: r.host, status: r.status }; }),
      result: { hash: S.res.hash, kind: lot.type, order: S.res.order, shares: S.res.shares }
    }, null, 1);
  }

  /* ---------------- verify ---------------- */

  function renderVerdict(v, beaconNote) {
    var rows = v.checks.map(function (c) {
      return [(c.ok ? "✓" : "✗") + " " + c.label, c.detail];
    });
    var html = '<h3 class="' + (v.ok ? "ok" : "bad") + '">' + (v.ok ? "Verified" : "Not verified") + "</h3>" +
      table(rows) +
      (beaconNote ? '<p class="hint">' + esc(beaconNote) + "</p>" : "") +
      (v.notes.length ? "<h3>Notes</h3><ul>" + v.notes.map(function (n) { return "<li><b>" + esc(n.label) + "</b> — " + esc(n.detail) + "</li>"; }).join("") + "</ul>" : "");
    if (v.result && v.lot) {
      var lot = v.lot, res = v.result, shown;
      if (lot.type === "allocation") shown = lot.names.map(function (nm, i) { return nm + ": " + res.shares[i]; }).join(" · ");
      else shown = res.order.map(function (ix) { return lot.names[ix]; }).join(" · ");
      html += "<h3>Recomputed result</h3><div class=\"card\">" + esc(shown) + "</div>" +
        '<p class="mono small">result hash ' + esc(res.hash) + "</p>";
    }
    $("vout").innerHTML = html;
  }

  async function doVerify() {
    $("verr").textContent = "";
    $("vout").innerHTML = "";
    try {
      var raw = $("vcode").value.trim(), extra = $("vbeacon").value.trim();
      var code = "", expected = null, o = null;
      try { o = JSON.parse(raw); } catch (e) { o = null; }
      if (o && o.token) { code = o.token; expected = o.result && o.result.hash; }
      else { var m = /L1-[A-Za-z0-9_-]+/.exec(raw); if (!m) throw new Error("no L1-… code found in the first box"); code = m[0]; }
      var lot = await L.decodeToken(code);
      var beacon = null, note = "";
      var text = extra || (o ? raw : "");
      if (text) {
        try {
          beacon = L.parseBeacon(text);
          if (beacon.round === null) { beacon.round = lot.drawRound; note = "The beacon had no round number, so the token's own draw round was assumed. That means the round itself was not independently checked — only the randomness was."; }
        } catch (e) { throw new Error("beacon: " + e.message); }
      } else if (!extra) {
        if (lot.drawRound > L.roundOf(Date.now() / 1000)) throw new Error("the draw has not happened yet (round " + group(lot.drawRound) + ")");
        var b = await L.fetchBeacon(lot.drawRound);
        if (b.ok) { beacon = { round: b.round, randomness: b.randomness, signature: b.signature }; note = b.agree + " of " + b.total + " relays returned identical round data."; }
        else throw new Error(b.notYet ? "round " + group(lot.drawRound) + " is not published yet" : "no relay agreement for round " + group(lot.drawRound));
      }
      var v = await L.verify(code, beacon, expected);
      if (beacon) v.notes.push({ label: "verification source", detail: extra ? "beacon supplied by hand (offline check)" : "beacon fetched live from drand relays" });
      renderVerdict(v, note);
    } catch (e) {
      $("verr").textContent = e.message;
    }
  }

  /* ---------------- wiring ---------------- */

  function parseLocation() {
    var t = new URLSearchParams(location.search).get("t");
    if (!t && location.hash.length > 1) t = new URLSearchParams(location.hash.slice(1)).get("t");
    return t;
  }

  async function loadCode(code) {
    try {
      S.lot = await L.decodeToken(code);
      S.code = code.replace(/\s+/g, "");
      S.tokenHash = await L.hashHex(S.lot.raw);
      /* a token read from a link never went through compile(), so its sizes are measured here */
      S.sizes = { raw: S.lot.raw.length, deflated: L.unb64url(S.code.slice(3)).length - 4, code: S.code.length };
      S.res = null; S.beacon = null;
      renderToken(false);
      renderFacts();
      $("vcode").value = S.code;
      $("vbeacon").value = "";
      $("vout").innerHTML = ""; $("result").innerHTML = ""; $("relays").innerHTML = "";
      $("proofbtns").hidden = true;
      show("secVerify", "secRun");
      msg("");
    } catch (e) {
      msg("That code cannot be read: " + e.message, "bad");
      show("secCreate");
    }
  }

  async function init() {
    syncKind();
    $("when").value = localInput(Math.floor(Date.now() / 1000) + 1800);
    previewRound();

    $("kind").addEventListener("change", function () { syncKind(); });
    $("when").addEventListener("change", previewRound);
    document.querySelectorAll("button[data-add]").forEach(function (b) {
      b.addEventListener("click", function () {
        $("when").value = localInput(Math.floor(Date.now() / 1000) + Number(b.dataset.add));
        previewRound();
      });
    });
    $("make").addEventListener("click", compile);
    $("drawbtn").addEventListener("click", doDraw);
    $("verifybtn").addEventListener("click", doVerify);
    $("navCreate").addEventListener("click", function () {
      var ids = ["secCreate"];
      if (S.code) ids.push("secToken");
      if (S.lot) ids.push("secRun");
      show.apply(null, ids);
    });
    $("navOpen").addEventListener("click", function () { show.apply(null, ["secVerify"].concat(S.lot ? ["secRun"] : [])); });
    $("copy").addEventListener("click", function () {
      copyText(S.code).then(function () { msg("Code copied.", "ok"); });
    });
    $("link").addEventListener("click", function () {
      var url = location.href.split(/[?#]/)[0] + "?t=" + encodeURIComponent(S.code);
      var box = $("linkbox");
      box.hidden = false;
      box.value = url;
      box.select();
      copyText(url).then(function () {
        msg("Link copied (" + url.length + " characters). Share it publicly at least 10 minutes before the draw" +
          (url.length > 1900 ? " — it is long, so some chat apps may cut it; sending the code itself, or the proof file, is safer." : "."), "ok");
      });
    });
    $("proofcopy").addEventListener("click", function () { copyText(proof()).then(function () { msg("Proof copied.", "ok"); }); });
    $("proofdl").addEventListener("click", function () {
      download("lotto-proof-" + S.lot.drawRound + ".json", proof());
    });

    var fromUrl = parseLocation();
    if (fromUrl) await loadCode(fromUrl);
    else show("secCreate");
  }

  init();
})();
//</app>
