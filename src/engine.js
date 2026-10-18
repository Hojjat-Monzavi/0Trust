//<engine>
/* LOTTO/1 — verifiable lottery engine.
   Pure: no DOM, no imports, integer-only (no floats in any random path), deterministic.
   The frozen spec is src/spec.html, which ships inside the page. */
var LOTTO = (function () {
  "use strict";

  var TAG = "LOTTO/1", VER = 1, U32 = 4294967296, MAXW = 4294967295;

  var CHAIN = {
    name: "quicknet",
    hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
    pub: "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
    scheme: "bls-unchained-g1-rfc9380",
    genesis: 1692803367, period: 3,
    relays: ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh"],
    docs: "https://drand.love/developer/"
  };

  var RULE = 200;   /* 200 rounds * 3 s = 10 minutes */
  /* The caps are enforced when a token is *read* as well as written, so a hostile token
     cannot make a verifier grind: the unweighted path is always O(n), the weighted one is
     the only super-linear code left and is bounded here. */
  var LIM = { n: 100000, name: 4096, k: 1000000, token: 2097152, raw: 8388608, weightedOrder: 10000, weightedWork: 200000000 };
  var KIND = ["selection", "ranking", "distribution", "allocation"];
  var KIND_ID = { selection: 0, ranking: 1, distribution: 2, allocation: 3 };

  /* ---------------- bytes ---------------- */

  var enc = new TextEncoder();
  var dec = new TextDecoder("utf-8", { fatal: true });

  function cat() {
    var n = 0, i, p = 0, o;
    for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    o = new Uint8Array(n);
    for (i = 0; i < arguments.length; i++) { o.set(arguments[i], p); p += arguments[i].length; }
    return o;
  }
  function u32be(n) { return Uint8Array.of(n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255); }
  function rd32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function vecU32(a) {
    var o = new Uint8Array(a.length * 4), i, p;
    for (i = 0, p = 0; i < a.length; i++, p += 4) { o[p] = a[i] >>> 24 & 255; o[p + 1] = a[i] >>> 16 & 255; o[p + 2] = a[i] >>> 8 & 255; o[p + 3] = a[i] & 255; }
    return o;
  }
  function toHex(b) { var s = "", i; for (i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16); return s; }
  function fromHex(h) {
    h = String(h).trim().toLowerCase();
    if (h.length % 2 || !/^[0-9a-f]*$/.test(h)) throw new Error("not a hexadecimal string");
    var o = new Uint8Array(h.length / 2), i;
    for (i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16);
    return o;
  }

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  function b64url(b) {
    var s = "", i, n;
    for (i = 0; i < b.length; i += 3) {
      n = (b[i] << 16) | ((b[i + 1] || 0) << 8) | (b[i + 2] || 0);
      s += B64[n >> 18 & 63] + B64[n >> 12 & 63] + (i + 1 < b.length ? B64[n >> 6 & 63] : "") + (i + 2 < b.length ? B64[n & 63] : "");
    }
    return s;
  }
  function unb64url(s) {
    var out = [], n = 0, bits = 0, i, v;
    for (i = 0; i < s.length; i++) {
      v = B64.indexOf(s[i]);
      if (v < 0) throw new Error("the code contains a character that is not valid base64url");
      n = (n << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out.push(n >> bits & 255); n &= (1 << bits) - 1; }
    }
    if (bits > 4 || n !== 0) throw new Error("the code is not a whole number of bytes");
    return new Uint8Array(out);
  }

  function varint(out, v) {
    if (!Number.isInteger(v) || v < 0) throw new Error("length out of range");
    for (;;) { var b = v & 127; v = Math.floor(v / 128); out.push(v ? b | 128 : b); if (!v) return; }
  }
  function rvarint(b, st) {
    var v = 0, shift = 0;
    for (;;) {
      if (st.o >= b.length) throw new Error("the code is truncated");
      var c = b[st.o++];
      v += (c & 127) * Math.pow(2, shift);
      if (!(c & 128)) return v;
      shift += 7;
      if (shift > 42) throw new Error("malformed variable-length integer");
    }
  }

  /* ---------------- SHA-256: WebCrypto, with a pure-JS fallback ---------------- */

  var KS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

  function sha256js(data) {
    var H0 = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    var len = data.length, total = (((len + 8) >> 6) << 6) + 64;
    var m = new Uint8Array(total), dv, w = new Uint32Array(64), off, i;
    m.set(data); m[len] = 128;
    dv = new DataView(m.buffer);
    dv.setUint32(total - 8, Math.floor(len / 536870912));
    dv.setUint32(total - 4, len * 8 % U32);
    for (off = 0; off < total; off += 64) {
      for (i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var x = w[i - 15], y = w[i - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = H0[0], b = H0[1], c = H0[2], d = H0[3], e = H0[4], f = H0[5], g = H0[6], h = H0[7];
      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var t1 = (h + S1 + ((e & f) ^ (~e & g)) + KS[i] + w[i]) >>> 0;
        var S2 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var t2 = (S2 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H0[0] = (H0[0] + a) >>> 0; H0[1] = (H0[1] + b) >>> 0; H0[2] = (H0[2] + c) >>> 0; H0[3] = (H0[3] + d) >>> 0;
      H0[4] = (H0[4] + e) >>> 0; H0[5] = (H0[5] + f) >>> 0; H0[6] = (H0[6] + g) >>> 0; H0[7] = (H0[7] + h) >>> 0;
    }
    var out = new Uint8Array(32);
    for (i = 0; i < 8; i++) { out[i * 4] = H0[i] >>> 24 & 255; out[i * 4 + 1] = H0[i] >>> 16 & 255; out[i * 4 + 2] = H0[i] >>> 8 & 255; out[i * 4 + 3] = H0[i] & 255; }
    return out;
  }

  var noSubtle = false;
  async function H(bytes) {
    var c = globalThis.crypto;
    if (!noSubtle && c && c.subtle) {
      try { return new Uint8Array(await c.subtle.digest("SHA-256", bytes)); }
      catch (e) { noSubtle = true; }
    }
    return sha256js(bytes);
  }
  const hashHex = async (b) => toHex(await H(b));

  /* ---------------- deflate-raw ---------------- */

  async function deflateRaw(bytes) {
    if (typeof CompressionStream === "undefined") throw new Error("this browser lacks CompressionStream (deflate-raw) support");
    const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  async function inflateRaw(bytes, cap) {
    if (typeof DecompressionStream === "undefined") throw new Error("this browser lacks DecompressionStream support");
    const r = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks = [];
    let len = 0;
    for (;;) {
      const x = await r.read();
      if (x.done) break;
      len += x.value.length;
      if (len > cap) { await r.cancel(); throw new Error("the code expands beyond the accepted size"); }
      chunks.push(x.value);
    }
    return cat.apply(null, chunks);
  }

  /* ---------------- token format ---------------- */

  function check(lot, rule) {
    var type = KIND_ID[lot.type];
    if (type === undefined) throw new Error("unknown lottery kind");
    var n = lot.names.length;
    if (!(n >= 1)) throw new Error("there are no participants");
    if (n > LIM.n) throw new Error("too many participants (max " + LIM.n + ")");
    var replacement = !!lot.replacement;
    if (replacement && lot.type !== "selection") throw new Error("with-replacement applies to selection only");
    var k = lot.type === "ranking" ? n : lot.k;
    if (!Number.isInteger(k) || k < 1) throw new Error("the count must be a whole number of at least 1");
    if (k > LIM.k) throw new Error("the count is too large (max " + LIM.k + ")");
    if (lot.type === "selection" && !replacement && k > n) throw new Error("more winners than participants");
    if (lot.type === "distribution" && k > n) throw new Error("more groups than participants");
    var weighted = false;
    if (lot.weights) {
      if (lot.weights.length !== n) throw new Error("the number of weights must match the number of participants");
      var sum = 0;
      for (var i = 0; i < n; i++) {
        var x = lot.weights[i];
        if (!Number.isInteger(x) || x < 0 || x > MAXW) throw new Error("each weight must be a whole number from 0 to " + MAXW);
        sum += x;
        if (x !== 1) weighted = true;
      }
      if (sum < 1) throw new Error("at least one weight must be positive");
      if (sum > MAXW) throw new Error("the total weight must not exceed " + MAXW);
      if (weighted && lot.type === "ranking") throw new Error("weighted ranking is not supported");
      if (weighted && lot.type === "distribution" && n > LIM.weightedOrder) throw new Error("weighted group assignment is limited to " + LIM.weightedOrder + " participants");
      if (weighted && lot.type === "selection" && n * k > LIM.weightedWork) throw new Error("this weighted draw would be too slow (participants × winners must stay under " + LIM.weightedWork + ")");
    }
    if (!Number.isInteger(lot.createdRound) || lot.createdRound < 1 || lot.createdRound >= U32) throw new Error("bad creation round");
    if (!Number.isInteger(lot.drawRound) || lot.drawRound < 1 || lot.drawRound >= U32) throw new Error("bad draw round");
    if (rule !== false && lot.drawRound - lot.createdRound < RULE) throw new Error("the draw must be at least " + (RULE * CHAIN.period / 60) + " minutes after the token is created (round +" + RULE + ")");
    return { type: type, replacement: replacement, k: k, weighted: weighted };
  }

  function pack(lot) {
    var c = check(lot), out = [], i, n = lot.names.length, nb = [];
    for (i = 0; i < n; i++) {
      var b = enc.encode(lot.names[i]);
      if (b.length > LIM.name) throw new Error("a name is longer than " + LIM.name + " bytes");
      nb.push(b);
    }
    var W = !!lot.weights && lot.weights.some(function (x) { return x !== 1; });
    out.push(VER, c.type, (W ? 1 : 0) | (c.replacement ? 2 : 0));
    out.push.apply(out, u32be(lot.createdRound));
    out.push.apply(out, u32be(lot.drawRound));
    out.push.apply(out, u32be(c.k));
    out.push.apply(out, u32be(n));
    for (i = 0; i < n; i++) { varint(out, nb[i].length); out.push.apply(out, nb[i]); }
    if (W) for (i = 0; i < n; i++) varint(out, lot.weights[i]);
    return Uint8Array.from(out);
  }

  function unpack(b) {
    var st = { o: 0 }, i, L;
    if (b.length < 19) throw new Error("the code is too short to be a token");
    if (b[st.o++] !== VER) throw new Error("unsupported token version: this page speaks LOTTO/" + VER + " only");
    var ti = b[st.o++];
    if (ti > 3) throw new Error("unknown lottery kind " + ti);
    var flags = b[st.o++];
    if (flags & ~3) throw new Error("unknown flags in the token");
    var createdRound = rd32(b, st.o); st.o += 4;
    var drawRound = rd32(b, st.o); st.o += 4;
    var k = rd32(b, st.o); st.o += 4;
    var n = rd32(b, st.o); st.o += 4;
    if (n < 1 || n > LIM.n) throw new Error("bad participant count in the token");
    var names = [];
    for (i = 0; i < n; i++) {
      L = rvarint(b, st);
      if (L > LIM.name) throw new Error("a name in the token is too long");
      if (st.o + L > b.length) throw new Error("the code is truncated");
      names.push(dec.decode(b.subarray(st.o, st.o + L)));
      st.o += L;
    }
    var weights = null;
    if (flags & 1) {
      weights = [];
      for (i = 0; i < n; i++) weights.push(rvarint(b, st));
    }
    if (st.o !== b.length) throw new Error("the token has trailing bytes");
    var lot = {
      ver: VER, type: KIND[ti], replacement: !!(flags & 2),
      createdRound: createdRound, drawRound: drawRound, k: k, n: n,
      names: names, weights: weights, raw: b
    };
    lot.weights = weights && weights.some(function (x) { return x !== 1; }) ? weights : null;
    check(lot, false);   /* structural only: a token that breaks the 10-minute rule must still be readable, so that its result can be audited */
    return lot;
  }

  async function encodeToken(lot) {
    var raw = pack(lot);
    var comp = await deflateRaw(raw);
    var sum = (await H(comp)).subarray(0, 4);
    var body = b64url(cat(comp, sum));
    return { code: "L1-" + body, raw: raw, sizes: { raw: raw.length, deflated: comp.length, code: body.length + 3 } };
  }

  async function decodeToken(code) {
    var s = String(code || "").replace(/\s+/g, "");
    if (!s) throw new Error("no code given");
    if (s.slice(0, 3) !== "L1-") throw new Error("the code must start with L1-");
    var b = unb64url(s.slice(3));
    if (b.length < 12) throw new Error("the code is too short to be a token");
    var comp = b.subarray(0, b.length - 4), sum = b.subarray(b.length - 4);
    if (comp.length > LIM.token) throw new Error("the code is larger than the accepted size");
    var chk = (await H(comp)).subarray(0, 4), i;
    for (i = 0; i < 4; i++) if (chk[i] !== sum[i]) throw new Error("the code is damaged (checksum mismatch)");
    return unpack(await inflateRaw(comp, LIM.raw));
  }

  /* ---------------- rounds ---------------- */

  function roundOf(t) { return Math.floor((t - CHAIN.genesis) / CHAIN.period) + 1; }
  function timeOfRound(r) { return CHAIN.genesis + (r - 1) * CHAIN.period; }
  function utc(t) { return new Date(t * 1000).toISOString().replace(".000Z", "Z"); }

  /* ---------------- the draw ----------------
     One sampler for everything: rand(n) is unbiased (rejection), and picking is a
     cumulative-weight walk over the remaining participants in their original order.
     With every weight equal to 1 the walk degenerates to "take the r-th remaining". */

  async function draw(lot, randomnessHex) {
    var rnd = fromHex(randomnessHex);
    if (rnd.length !== 32) throw new Error("the beacon randomness must be 32 bytes (64 hex characters)");
    var S = await H(cat(enc.encode(TAG), lot.raw, rnd));
    var blk = null, bi = -1, pos = 0;

    async function word(i) {
      var b = i >> 3, j = i & 7;
      if (b !== bi) { blk = await H(cat(S, u32be(b))); bi = b; }
      return rd32(blk, j * 4);
    }
    async function rand(n) {
      if (!(n >= 1) || n > U32) throw new Error("random range out of bounds");
      var L = U32 - (U32 % n);
      for (;;) { var w = await word(pos++); if (w < L) return w % n; }
    }

    var n = lot.n, i, j, t, p;

    if (lot.type === "allocation") return alloc(lot, lot.k, rand);

    /* Unweighted draws are one Fisher–Yates permutation, which is O(n) for every kind:
       ranking is the whole permutation, selection its first k, distribution gets cut into
       blocks. Weighted draws need the cumulative walk, so they are the only ones capped. */
    if (!lot.weights) {
      p = new Array(n);
      for (i = 0; i < n; i++) p[i] = i;
      for (i = n - 1; i > 0; i--) { j = await rand(i + 1); t = p[i]; p[i] = p[j]; p[j] = t; }
      var cut = lot.type === "selection" ? p.slice(0, lot.k) : p;
      return { order: cut, vector: vecU32(cut) };
    }

    var k = lot.type === "distribution" ? n : lot.k;
    var ww = lot.weights.slice(), sum = 0, rem = new Array(n), picks = [], acc, idx, it;
    for (i = 0; i < n; i++) { sum += ww[i]; rem[i] = i; }
    for (t = 0; t < k; t++) {
      var r = await rand(sum);
      acc = 0; idx = 0;
      for (i = 0; i < rem.length; i++) { acc += ww[rem[i]]; if (r < acc) { idx = i; break; } }
      it = rem[idx];
      picks.push(it);
      if (!lot.replacement) { sum -= ww[it]; ww[it] = 0; rem.splice(idx, 1); }
    }
    return { order: picks, vector: vecU32(picks) };
  }

  /* Allocation: exact integer shares (floor), leftover units to the largest remainders
     (P*w_i mod W), boundary ties broken by the beacon stream. */
  async function alloc(lot, P, rand) {
    var n = lot.n, w = lot.weights || new Array(n).fill(1), i, sum = 0;
    for (i = 0; i < n; i++) sum += w[i];
    if (sum < 1) throw new Error("the total weight must be at least 1");
    var Wb = BigInt(sum), Pb = BigInt(P);
    var base = new Array(n), frac = new Array(n), placed = 0, prod;
    for (i = 0; i < n; i++) {
      prod = Pb * BigInt(w[i]);
      base[i] = Number(prod / Wb);
      frac[i] = prod % Wb;
      placed += base[i];
    }
    var r = P - placed;
    if (r <= 0) return { shares: base, vector: vecU32(base) };
    var idx = [];
    for (i = 0; i < n; i++) idx[i] = i;
    idx.sort(function (a, b) { return frac[a] > frac[b] ? -1 : frac[a] < frac[b] ? 1 : a - b; });
    var cut = frac[idx[r - 1]], lo = r, hi = r;
    while (lo > 0 && frac[idx[lo - 1]] === cut) lo--;
    while (hi < n && frac[idx[hi]] === cut) hi++;
    for (i = 0; i < lo; i++) base[idx[i]]++;      /* the strictly larger remainders take their unit first */
    var group = idx.slice(lo, hi), need = r - lo, keys;
    if (need > 0) {
      if (group.length <= need) {
        for (i = 0; i < group.length; i++) base[group[i]]++;
      } else {
        keys = [];
        for (i = 0; i < group.length; i++) keys.push([await rand(U32), group[i]]);
        keys.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
        for (i = 0; i < need; i++) base[keys[i][1]]++;
      }
    }
    return { shares: base, vector: vecU32(base) };
  }

  /* ---------------- run, beacon, verify ---------------- */

  async function run(lot, beacon) {
    var round = Number(beacon.round), rnd = String(beacon.randomness || "").toLowerCase();
    if (round !== lot.drawRound) throw new Error("beacon round " + round + " is not the token draw round " + lot.drawRound);
    if (!/^[0-9a-f]{64}$/.test(rnd)) throw new Error("the beacon randomness must be 64 hex characters");
    var out = await draw(lot, rnd);
    var h = await H(cat(enc.encode(TAG), Uint8Array.of(KIND_ID[lot.type]), u32be(round), out.vector));
    return { hash: toHex(h), round: round, kind: lot.type, order: out.order || null, shares: out.shares || null, vector: out.vector };
  }

  /* A relay that accepts the connection and then goes quiet must not freeze the page:
     every request carries a deadline, and a slow relay is treated as an absent one. */
  var RELAY_TIMEOUT = 12000;
  function deadline(ms) {
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms);
    if (typeof AbortController !== "undefined") {
      var c = new AbortController();
      setTimeout(function () { c.abort(); }, ms);
      return c.signal;
    }
    return undefined;
  }

  async function fetchBeacon(round) {
    var out = CHAIN.relays.map(function (h) { return { host: h, status: "waiting" }; });
    await Promise.all(out.map(async function (r) {
      r.url = r.host + "/" + CHAIN.hash + "/public/" + round;
      try {
        var res = await fetch(r.url, { cache: "no-store", signal: deadline(RELAY_TIMEOUT) });
        if (res.status === 425 || res.status === 404) { r.status = "not published yet"; return; }
        if (!res.ok) { r.status = "HTTP " + res.status; return; }
        var j = await res.json();
        if (Number(j.round) !== Number(round) || !/^[0-9a-f]{64}$/.test(j.randomness || "") || !/^[0-9a-f]{96}$/.test(j.signature || "")) { r.status = "malformed reply"; return; }
        r.status = "ok"; r.randomness = j.randomness; r.signature = j.signature;
      } catch (e) { r.status = "unreachable"; }
    }));
    var groups = {}, best = null;
    out.forEach(function (r) {
      if (r.status !== "ok") return;
      var key = r.randomness + r.signature;
      (groups[key] = groups[key] || []).push(r.host);
    });
    Object.keys(groups).forEach(function (k) { if (!best || groups[k].length > groups[best].length) best = k; });
    var agree = best ? groups[best].length : 0;
    return {
      round: Number(round), relays: out, agree: agree, total: out.length, ok: agree >= 2,
      notYet: out.every(function (r) { return r.status === "not published yet"; }),
      randomness: best ? best.slice(0, 64) : null,
      signature: best ? best.slice(64) : null
    };
  }

  /* Takes a beacon JSON blob, a proof JSON blob, or loose text with a round + 64 hex + 96 hex. */
  function parseBeacon(text) {
    if (!text) throw new Error("no beacon data given");
    var o = null, m;
    try { o = JSON.parse(text); } catch (e) { o = null; }
    if (o && o.beacon) o = o.beacon;
    if (!o || typeof o !== "object") {
      var m1 = /[0-9a-f]{64}/i.exec(text);
      var m2 = /[0-9a-f]{96}/i.exec(text);
      var m3 = /"round"\s*:\s*(\d+)/i.exec(text) || /\bround\D{0,8}(\d{1,10})\b/i.exec(text);
      o = { round: m3 && +m3[1], randomness: m1 && m1[0], signature: m2 && m2[0] };
    }
    m = o.randomness === undefined ? null : String(o.randomness);
    if (!m || !/^[0-9a-f]{64}$/i.test(m)) throw new Error("no 64-character randomness found in the beacon data");
    return {
      round: o.round === undefined || o.round === null ? null : Number(o.round),
      randomness: m.toLowerCase(),
      signature: o.signature ? String(o.signature).toLowerCase() : null
    };
  }

  /* Audit: checks[] decide whether the result is authentic, notes[] are policy caveats. */
  async function verify(code, beacon, expectedHash) {
    var checks = [], notes = [], lot = null, result = null;
    function add(ok, label, detail) { checks.push({ ok: !!ok, label: label, detail: detail || "" }); }
    function note(label, detail) { notes.push({ label: label, detail: detail || "" }); }

    try {
      lot = await decodeToken(code);
    } catch (e) {
      add(false, "code integrity", e.message);
      return { ok: false, checks: checks, notes: notes, lot: null, result: null };
    }
    add(true, "code integrity", "checksum ok · " + lot.raw.length + " bytes · " + lot.n + " participants");
    add(true, "engine version", "LOTTO/" + lot.ver + " · " + lot.type + (lot.replacement ? " · with replacement" : "") + (lot.weights ? " · weighted" : ""));

    var d = lot.drawRound - lot.createdRound;
    var ruleOk = d >= RULE;
    add(ruleOk, "10-minute rule", "created round " + lot.createdRound + " → draw round " + lot.drawRound + " (Δ " + d + " rounds" + (ruleOk ? "" : ", needs ≥ " + RULE) + ")");
    note("commit-reveal caveat", "the creation round is written by whoever made the token, so a past creation round proves nothing by itself. If the token hash " + (await hashHex(lot.raw)).slice(0, 16) + "… was published before round " + lot.drawRound + "'s beacon existed, nobody could grind the result.");
    note("draw round time", utc(timeOfRound(lot.drawRound)) + " (round " + lot.drawRound + ")");

    if (!beacon) {
      add(false, "beacon", "no beacon supplied, so the result cannot be recomputed");
      return { ok: false, checks: checks, notes: notes, lot: lot, result: null };
    }

    var same = Number(beacon.round) === lot.drawRound;
    add(same, "beacon round", "beacon " + beacon.round + " vs token draw round " + lot.drawRound);

    if (beacon.signature && /^[0-9a-f]{96}$/.test(beacon.signature) && /^[0-9a-f]{64}$/.test(beacon.randomness)) {
      var sh = await hashHex(fromHex(beacon.signature));
      add(sh === beacon.randomness, "beacon consistency", "SHA256(signature) == randomness");
      note("BLS", "the signature itself needs a pairing check: scheme " + CHAIN.scheme + ", public key " + CHAIN.pub.slice(0, 16) + "… — any drand client can verify it offline.");
    } else if (beacon.signature) {
      add(false, "beacon signature", "the signature is not 96 hex characters");
    } else {
      note("no signature", "only the randomness was supplied, so it cannot be traced back to a drand signature");
    }

    if (same && /^[0-9a-f]{64}$/.test(beacon.randomness)) {
      try {
        result = await run(lot, beacon);
        add(!expectedHash || String(expectedHash).toLowerCase() === result.hash, "result hash", result.hash + (expectedHash ? " vs " + String(expectedHash).toLowerCase() + " in the proof" : " (recomputed here)"));
      } catch (e) { add(false, "draw", e.message); }
    }
    return { ok: checks.every(function (c) { return c.ok; }), checks: checks, notes: notes, lot: lot, result: result };
  }

  return {
    TAG: TAG, VER: VER, CHAIN: CHAIN, RULE: RULE, LIM: LIM, KIND: KIND,
    roundOf: roundOf, timeOfRound: timeOfRound, utc: utc,
    pack: pack, unpack: unpack, encodeToken: encodeToken, decodeToken: decodeToken,
    draw: draw, run: run, fetchBeacon: fetchBeacon, parseBeacon: parseBeacon, verify: verify,
    hashHex: hashHex, sha256js: sha256js, tokenHash: hashHex,
    b64url: b64url, unb64url: unb64url, toHex: toHex, fromHex: fromHex, u32be: u32be, vecU32: vecU32,
    _limit: function (n) { return U32 - (U32 % n); },
    _forceJS: function (v) { noSubtle = v !== false; }
  };
})();
if (typeof module !== "undefined" && module.exports) module.exports = LOTTO;
//</engine>
