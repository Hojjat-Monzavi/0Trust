/* engine.test.mjs — the guard rail. Run with: node --test tests/
   Heavy statistical tests force the pure-JS SHA-256 path, which is the one old
   browsers use, so both hash paths get exercised. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const L = require("../src/engine.js");
const V = JSON.parse(readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));
const te = new TextEncoder();
const beaconOf = (s) => L.toHex(L.sha256js(te.encode(s)));
const lotOf = (spec) => L.unpack(L.pack(Object.assign({ createdRound: 1, drawRound: 201, names: ["a", "b", "c", "d", "e", "f", "g", "h"] }, spec)));
const BEACON = "d29d40494a96f846c69274b948ae0b53918441345a6be01bb2940ef127c892af";

/* the fuzzers use a fixed seed: broad coverage, but the same run every time */
let _seed = 0x12345678;
const rnd = () => {
  _seed ^= _seed << 13; _seed >>>= 0;
  _seed ^= _seed >>> 17;
  _seed ^= _seed << 5; _seed >>>= 0;
  return _seed / 4294967296;
};

/* ---------------- primitives ---------------- */

test("the engine module exposes its whole surface (guards against a silent load failure)", () => {
  for (const name of ["encodeToken", "decodeToken", "pack", "unpack", "draw", "run", "verify", "fetchBeacon",
    "parseBeacon", "hashHex", "sha256js", "tokenHash", "b64url", "unb64url", "toHex", "fromHex", "u32be", "vecU32",
    "roundOf", "timeOfRound", "utc", "_limit", "_forceJS"]) {
    assert.equal(typeof L[name], "function", "engine." + name);
  }
  assert.equal(L.TAG, "LOTTO/1");
  assert.equal(L.VER, 1);
  assert.equal(L.RULE, 200);
  assert.equal(L.CHAIN.hash.length, 64);
  assert.equal(L.CHAIN.pub.length, 192);
  assert.equal(L.CHAIN.relays.length, 3);
  assert.deepEqual(L.KIND, ["selection", "ranking", "distribution", "allocation"]);
  assert.ok(V.length >= 25, "the vector file looks truncated");
});

test("pure-JS SHA-256 agrees with WebCrypto and with the known vectors", async () => {
  assert.equal(L.toHex(L.sha256js(te.encode(""))), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(L.toHex(L.sha256js(te.encode("abc"))), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const len of [0, 1, 2, 3, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 255, 1000, 4096]) {
    const b = new Uint8Array(len).map((_, i) => (i * 7 + len) & 255);
    assert.equal(L.toHex(L.sha256js(b)), await L.hashHex(b), "length " + len);
  }
  const big = new Uint8Array(200000).map((_, i) => (i * 31) & 255);
  assert.equal(L.toHex(L.sha256js(big)), await L.hashHex(big), "multi-block");
});

test("base64url round-trips and rejects anything that is not whole bytes", () => {
  for (let len = 0; len < 40; len++) {
    const b = new Uint8Array(len).map((_, i) => (i * 31 + len * 11) & 255);
    assert.deepEqual(Array.from(L.unb64url(L.b64url(b))), Array.from(b), "length " + len);
  }
  assert.throws(() => L.unb64url("a+b"), /base64url/);
  assert.throws(() => L.unb64url("a=b"), /base64url/);
  assert.throws(() => L.unb64url("A"), /whole number/);
  assert.throws(() => L.unb64url("QR"), /whole number/);
});

test("rejection sampling bounds are exact", () => {
  assert.equal(L._limit(1), 4294967296);
  assert.equal(L._limit(2), 4294967296);
  assert.equal(L._limit(3), 4294967295);
  assert.equal(L._limit(4), 4294967296);
  assert.equal(L._limit(5), 4294967295);
  assert.equal(L._limit(4294967295), 4294967295);
  assert.equal(L._limit(4294967296), 4294967296);
});

test("round arithmetic matches drand", () => {
  assert.equal(L.roundOf(1692803367), 1);
  assert.equal(L.roundOf(1692803368), 1);
  assert.equal(L.roundOf(1692803369), 1);
  assert.equal(L.roundOf(1692803370), 2);
  assert.equal(L.timeOfRound(1), 1692803367);
  assert.equal(L.timeOfRound(2), 1692803370);
  for (const r of [1, 2, 3, 1000, 33181883, 4000000000]) assert.equal(L.roundOf(L.timeOfRound(r)), r, "round " + r);
  assert.equal(L.roundOf(Date.now() / 1000), L.roundOf(Math.floor(Date.now() / 1000)));
});

/* ---------------- the vectors (cross-implementation) ---------------- */

test("every vector decodes, re-encodes byte-for-byte, and draws identically", async () => {
  let digits = 0;
  for (const v of V) {
    const lot = await L.decodeToken(v.code);
    assert.equal(lot.type, v.kind, v.name);
    assert.equal(lot.n, v.n, v.name);
    assert.equal(lot.k, v.k, v.name);
    assert.equal(lot.replacement, v.replacement, v.name);
    assert.deepEqual(lot.names, v.names, v.name);
    assert.deepEqual(lot.weights, v.weights, v.name);
    assert.equal(L.toHex(lot.raw), v.raw, v.name + " raw bytes");
    assert.equal(L.toHex(L.pack(lot)), v.raw, v.name + " re-encode");
    for (const tag of Object.keys(v.draws)) {
      const d = v.draws[tag];
      const res = await L.run(lot, { round: v.drawRound, randomness: d.randomness });
      assert.equal(res.hash, d.hash, v.name + "/" + tag + " result hash");
      assert.deepEqual(lot.type === "allocation" ? res.shares : res.order, d.vector, v.name + "/" + tag + " vector");
      digits += res.hash.length;
    }
  }
  assert.ok(digits > 1000);
});

test("a foreign (zlib) deflate stream in a code is accepted", async () => {
  const lot = await L.decodeToken(V[0].code);
  assert.equal(lot.n, V[0].n);
  const mine = await L.encodeToken(lot);
  assert.notEqual(mine.code, V[0].code, "the two compressors may differ, and that is fine");
  assert.equal(L.toHex((await L.decodeToken(mine.code)).raw), V[0].raw);
});

/* ---------------- fairness ---------------- */

test("all 24 orderings of 4 participants are equally likely (chi-square)", async () => {
  L._forceJS(true);
  const lot = lotOf({ type: "ranking", k: 4, names: ["a", "b", "c", "d"] });
  const N = 24 * 2000, counts = new Map();
  for (let i = 0; i < N; i++) {
    const key = (await L.draw(lot, beaconOf("perm:" + i))).order.join("");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  L._forceJS(false);
  assert.equal(counts.size, 24, "every ordering must be reachable");
  const exp = N / 24;
  let chi = 0;
  for (const c of counts.values()) chi += (c - exp) ** 2 / exp;
  assert.ok(chi < 60, "chi-square " + chi.toFixed(1) + " with 23 degrees of freedom (p=0.001 is 49.7)");
});

test("rand(n) carries no modulo bias", async () => {
  L._forceJS(true);
  const crit = { 2: 16, 3: 16, 5: 22, 7: 27 };
  for (const n of [2, 3, 5, 7]) {
    const trials = 30000 * (n < 5 ? 1 : 0.7);
    const lot = lotOf({ type: "selection", k: 1, names: "abcdefgh".slice(0, n).split("") });
    const counts = new Array(n).fill(0);
    for (let i = 0; i < trials; i++) counts[(await L.draw(lot, beaconOf("bias:" + n + ":" + i))).order[0]]++;
    const exp = trials / n;
    const chi = counts.reduce((a, c) => a + (c - exp) ** 2 / exp, 0);
    assert.ok(chi < crit[n], "n=" + n + " chi-square " + chi.toFixed(2) + " (limit " + crit[n] + ")");
  }
  L._forceJS(false);
});

test("weighted selection follows the weights, and a zero weight never wins", async () => {
  L._forceJS(true);
  const w = [1, 3, 0, 6];
  const lot = lotOf({ type: "selection", k: 1, weights: w, names: ["a", "b", "c", "d"] });
  const trials = 40000, counts = [0, 0, 0, 0];
  for (let i = 0; i < trials; i++) counts[(await L.draw(lot, beaconOf("weighted:" + i))).order[0]]++;
  L._forceJS(false);
  assert.equal(counts[2], 0, "a weight of 0 must never be drawn");
  for (const i of [0, 1, 3]) {
    const p = w[i] / 10, got = counts[i] / trials;
    assert.ok(Math.abs(got - p) < 0.02, "index " + i + ": expected about " + p + ", saw " + got.toFixed(4));
  }
});

test("weighted selection without replacement never repeats a participant", async () => {
  const lot = lotOf({ type: "selection", k: 4, weights: [5, 1, 9, 1, 1, 1, 1, 1], names: "abcdefgh".split("") });
  for (let i = 0; i < 2000; i++) {
    const order = (await L.draw(lot, beaconOf("wor:" + i))).order;
    assert.equal(new Set(order).size, 4);
  }
});

test("weighted selection with replacement can repeat, and only the positive weights appear", async () => {
  const lot = lotOf({ type: "selection", k: 40, replacement: true, weights: [1, 0, 2, 0, 0, 0, 0, 0], names: "abcdefgh".split("") });
  const order = (await L.draw(lot, BEACON)).order;
  assert.equal(order.length, 40);
  assert.ok(order.every((x) => x === 0 || x === 2));
});

test("allocation divides the pool exactly and stays inside floor/ceil of the ideal share", async () => {
  L._forceJS(true);
  let seed = 987654321;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let t = 0; t < 400; t++) {
    const n = 1 + Math.floor(rnd() * 8);
    const P = 1 + Math.floor(rnd() * 60);
    const w = Array.from({ length: n }, () => Math.floor(rnd() * 7));
    if (w.reduce((a, b) => a + b, 0) < 1) w[0] = 1;
    const lot = lotOf({ type: "allocation", k: P, weights: w, names: Array.from({ length: n }, (_, i) => "p" + i) });
    const { shares } = await L.draw(lot, beaconOf("alloc:" + t));
    const W = w.reduce((a, b) => a + b, 0);
    assert.equal(shares.reduce((a, b) => a + b, 0), P, "pool " + P + " with weights " + w.join(","));
    for (let i = 0; i < n; i++) {
      assert.ok(shares[i] >= Math.floor(P * w[i] / W), "under the exact floor");
      assert.ok(shares[i] <= Math.ceil(P * w[i] / W), "over the exact ceiling");
      if (w[i] === 0) assert.equal(shares[i], 0);
    }
  }
  L._forceJS(false);
});

test("an unweighted draw is a permutation", async () => {
  const n = 500;
  for (const kind of ["ranking", "distribution"]) {
    const lot = lotOf({ type: kind, k: kind === "distribution" ? 7 : n, names: Array.from({ length: n }, (_, i) => "p" + i) });
    const order = (await L.draw(lot, beaconOf(kind))).order;
    assert.equal(order.length, n, kind);
    assert.deepEqual([...order].sort((a, b) => a - b), Array.from({ length: n }, (_, i) => i), kind);
  }
});

test("distribution block sizes differ by at most one, larger blocks first", async () => {
  for (const [n, G] of [[7, 3], [6, 4], [5, 5], [10, 1], [9, 2]]) {
    const lot = lotOf({ type: "distribution", k: G, names: Array.from({ length: n }, (_, i) => "p" + i) });
    const order = (await L.draw(lot, beaconOf("blocks:" + n + ":" + G))).order;
    const base = Math.floor(n / G), rem = n % G, sizes = Array.from({ length: G }, (_, g) => base + (g < rem ? 1 : 0));
    let p = 0;
    for (const s of sizes) { assert.equal(new Set(order.slice(p, p + s)).size, s); p += s; }
    assert.equal(p, n);
    assert.ok(sizes.every((s) => s === sizes[0] || s === sizes[0] - 1));
  }
});

test("the draw is deterministic: same token, same beacon, same result", async () => {
  for (const v of V) {
    const a = await L.run(await L.decodeToken(v.code), { round: v.drawRound, randomness: BEACON });
    const b = await L.run(await L.decodeToken(v.code), { round: v.drawRound, randomness: BEACON });
    assert.equal(a.hash, b.hash, v.name);
    assert.deepEqual(a.vector, b.vector, v.name);
  }
});

test("different beacons give different results", async () => {
  const lot = lotOf({ type: "ranking", names: Array.from({ length: 30 }, (_, i) => "p" + i) });
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const r = beaconOf("beacon-diff:" + i);
    seen.add((await L.run(lot, { round: lot.drawRound, randomness: r })).hash);
  }
  assert.equal(seen.size, 50);
});

/* ---------------- hostile input ---------------- */

test("relays that never answer cannot freeze the draw", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (url, opts) => {
    calls++;
    assert.ok(opts && opts.signal, "the request must carry a deadline");
    return new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
      if (opts.signal.aborted) reject(new Error("aborted"));
    });
  };
  try {
    const t0 = Date.now(), b = await L.fetchBeacon(1), ms = Date.now() - t0;
    assert.equal(calls, 3, "all three relays are asked in parallel");
    assert.equal(b.ok, false);
    assert.equal(b.agree, 0);
    assert.deepEqual(b.relays.map((r) => r.status), ["unreachable", "unreachable", "unreachable"]);
    assert.ok(ms < 40000, "three dead relays took " + ms + " ms — the deadline is not working");
  } finally { globalThis.fetch = real; }
});

test("a damaged code never silently verifies", async () => {
  const b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let breached = 0;
  for (let i = 0; i < 4000; i++) {
    const v = V[i % V.length];
    const s = v.code, p = 3 + Math.floor(rnd() * (s.length - 3));
    let m;
    if (i % 4 === 0) m = s.slice(0, p);
    else if (i % 4 === 1) m = s.slice(0, p) + b64[Math.floor(rnd() * 64)] + s.slice(p + 1);
    else if (i % 4 === 2) m = s + b64[Math.floor(rnd() * 64)];
    else m = s.slice(0, p) + b64[Math.floor(rnd() * 64)] + s.slice(p);
    let got = null;
    try { got = L.toHex((await L.decodeToken(m)).raw); } catch (e) { assert.ok(e instanceof Error); }
    /* a code that decodes into the very same bytes is not damage: an edit can land in
       the padding bits of the last base64url character, which the format ignores. What
       must never happen is a damaged code decoding into different bytes. */
    if (got !== null && got !== v.raw) breached++;
  }
  assert.equal(breached, 0, breached + " damaged codes decoded into different bytes");
});

test("unpack never hangs or explodes on random bytes", () => {
  for (let i = 0; i < 30000; i++) {
    const n = 19 + Math.floor(rnd() * 60);
    const b = new Uint8Array(n).map(() => Math.floor(rnd() * 256));
    try {
      const lot = L.unpack(b);
      assert.ok(lot.n >= 1 && lot.n <= 100000);
      assert.equal(lot.names.length, lot.n);
    } catch (e) { assert.ok(e instanceof Error); }
  }
});

test("the decoder refuses structurally impossible tokens", () => {
  const raw = L.pack({ type: "ranking", names: ["a", "b", "c"], createdRound: 1, drawRound: 201 });
  const mut = (fn) => { const c = raw.slice(); fn(c); return c; };
  assert.throws(() => L.unpack(raw.slice(0, 18)), /too short/);
  assert.throws(() => L.unpack(mut((c) => { c[0] = 2; })), /version/);
  assert.throws(() => L.unpack(mut((c) => { c[1] = 9; })), /kind/);
  assert.throws(() => L.unpack(mut((c) => { c[2] = 8; })), /flags/);
  assert.throws(() => L.unpack(mut((c) => { c[15] = 0; c[16] = 0; c[17] = 0; c[18] = 0; })), /participant count/);
  assert.throws(() => L.unpack(mut((c) => { c[3] = 0; c[4] = 0; c[5] = 0; c[6] = 0; })), /creation round|count|round/);
  assert.throws(() => L.unpack(new Uint8Array([...raw, 0])), /trailing/);
});

test("the encoder refuses nonsense", () => {
  const base = { type: "selection", k: 1, names: ["a", "b"], createdRound: 1, drawRound: 201 };
  const bad = [
    ["no participants", { names: [] }],
    ["more winners than participants", { k: 3 }],
    ["no winners", { k: 0 }],
    ["fractional winners", { k: 1.5 }],
    ["draw too soon", { drawRound: 200 }],
    ["ranked with weights", { type: "ranking", weights: [1, 2] }],
    ["weight count mismatch", { weights: [1] }],
    ["all weights zero", { weights: [0, 0] }],
    ["weight too large", { weights: [1, 4294967296] }],
    ["weight total too large", { weights: [4294967295, 1] }],
    ["unknown kind", { type: "raffle" }],
    ["replacement outside selection", { type: "ranking", replacement: true }],
    ["more groups than participants", { type: "distribution", k: 3 }],
    ["empty pool", { type: "allocation", k: 0, weights: [1, 1] }],
    ["creation round zero", { createdRound: 0 }],
    ["draw round zero", { drawRound: 0 }]
  ];
  for (const [label, patch] of bad) assert.throws(() => L.pack(Object.assign({}, base, patch)), Error, label);
  assert.throws(() => L.pack(Object.assign({}, base, { names: new Array(100001).fill("x") })), /too many/);
  assert.throws(() => L.pack(Object.assign({}, base, { names: ["y".repeat(4097), "b"] })), /longer than/);
  assert.throws(() => L.pack(Object.assign({}, base, { k: 1000001, replacement: true })), /too large/);
  /* the cost caps must apply when reading too, so they cannot be smuggled in */
  assert.throws(() => L.pack(Object.assign({}, base, { type: "selection", k: 30000, weights: new Array(30000).fill(2), names: new Array(30000).fill("x") })), /too slow/);
  assert.throws(() => L.pack(Object.assign({}, base, { type: "distribution", k: 2, weights: new Array(10001).fill(2), names: new Array(10001).fill("x") })), /limited to/);
});

test("a token that breaks the 10-minute rule is readable, drawable and reported", async () => {
  const v = V[0];
  const raw = L.fromHex(v.raw);
  const created = v.drawRound - 5;
  raw[3] = created >>> 24 & 255; raw[4] = created >>> 16 & 255; raw[5] = created >>> 8 & 255; raw[6] = created & 255;
  const comp = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const full = new Uint8Array(comp.length + 4);
  full.set(comp);
  full.set((await L.hashHex(comp)).match(/../g).slice(0, 4).map((x) => parseInt(x, 16)), comp.length);
  const code = "L1-" + L.b64url(full);
  const lot = await L.decodeToken(code);
  assert.equal(lot.createdRound, created);
  const res = await L.run(lot, { round: lot.drawRound, randomness: BEACON });
  assert.equal(res.hash.length, 64);
  const audit = await L.verify(code, { round: lot.drawRound, randomness: BEACON }, null);
  assert.equal(audit.ok, false);
  assert.equal(audit.checks.find((c) => c.label === "10-minute rule").ok, false);
  assert.ok(audit.result && audit.result.hash === res.hash, "the result is still recomputed");
});

/* ---------------- verify() ---------------- */

test("verify() audits a code against a beacon", async () => {
  const v = V[0], d = v.draws["beacon-a"];
  const good = await L.verify(v.code, { round: v.drawRound, randomness: d.randomness, signature: null }, d.hash);
  assert.ok(good.checks.every((c) => c.ok), JSON.stringify(good.checks.filter((c) => !c.ok)));
  assert.equal(good.ok, true);
  assert.equal(good.result.hash, d.hash);
  assert.ok(good.notes.some((n) => /signature/.test(n.label)));

  const wrongHash = await L.verify(v.code, { round: v.drawRound, randomness: d.randomness }, "00".repeat(32));
  assert.equal(wrongHash.ok, false);
  assert.equal(wrongHash.checks.find((c) => c.label === "result hash").ok, false);

  const wrongRound = await L.verify(v.code, { round: v.drawRound + 1, randomness: d.randomness }, null);
  assert.equal(wrongRound.ok, false);

  const noBeacon = await L.verify(v.code, null, null);
  assert.equal(noBeacon.ok, false);
  assert.equal(noBeacon.lot.type, "selection");

  const garbled = await L.verify("L1-not-a-real-code", null, null);
  assert.equal(garbled.ok, false);
  assert.equal(garbled.lot, null);
  assert.match(garbled.checks[0].detail, /base64url|damaged|short|checksum|whole number/i);
});

test("verify() checks a real beacon's signature against its randomness", async () => {
  const b = await L.fetchBeacon(L.roundOf(Date.now() / 1000) - 4).catch(() => null);
  if (!b || !b.ok) return;                       /* offline: the unit tests above still cover the logic */
  const sig = L.fromHex(b.signature);
  assert.equal(L.toHex(await L.sha256js(sig)), b.randomness, "drand defines randomness = SHA256(signature)");
});

/* ---------------- scale ---------------- */

test("100000 participants: encode, decode and draw stay fast", async () => {
  const names = Array.from({ length: 100000 }, (_, i) => "participant-" + i);
  let t = Date.now();
  const out = await L.encodeToken({ type: "ranking", names, createdRound: 1, drawRound: 201 });
  const tEncode = Date.now() - t;
  t = Date.now();
  const lot = await L.decodeToken(out.code);
  const tDecode = Date.now() - t;
  t = Date.now();
  const res = await L.draw(lot, BEACON);
  const tDraw = Date.now() - t;
  assert.equal(res.order.length, 100000);
  const seen = new Uint8Array(100000);
  for (const x of res.order) { assert.ok(!seen[x]); seen[x] = 1; }
  assert.ok(tDraw < 60000, "drawing took " + tDraw + " ms");
  console.log("    100k ranking: encode " + tEncode + " ms · decode " + tDecode + " ms · draw " + tDraw + " ms · code " + out.sizes.code + " chars (from " + out.sizes.raw + " bytes)");
});

test("100000 participants into 200 groups", async () => {
  const names = Array.from({ length: 100000 }, (_, i) => "p" + i);
  const lot = await L.decodeToken((await L.encodeToken({ type: "distribution", k: 200, names, createdRound: 1, drawRound: 201 })).code);
  const t = Date.now();
  const res = await L.draw(lot, BEACON);
  assert.equal(res.order.length, 100000);
  assert.equal(new Set(res.order).size, 100000);
  console.log("    100k into 200 groups: " + (Date.now() - t) + " ms");
});
