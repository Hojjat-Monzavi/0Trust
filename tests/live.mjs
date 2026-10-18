/* live.mjs — the real thing: talk to the three drand relays and audit the result.
   Skips itself (loudly) when there is no network. */
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const L = createRequire(import.meta.url)("../src/engine.js");

/* a flaky network must not turn into a false failure, and a wrong chain parameter
   must not hide behind a skip: retry the probe, then assert outside the try */
let online = false;
let info = null;
for (let i = 0; i < 4 && !online; i++) {
  try {
    const r = await fetch(L.CHAIN.relays[0] + "/" + L.CHAIN.hash + "/info", { signal: AbortSignal.timeout(15000) });
    online = r.ok;
    if (online) info = await r.json();
  } catch (e) { online = false; }
  if (!online) await new Promise((r) => setTimeout(r, 4000));
}

/* a relay can drop out for a moment; the page retries, so the test does too */
async function beaconAt(round, tries = 8) {
  let b = await L.fetchBeacon(round);
  for (let i = 0; i < tries && !b.ok; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    b = await L.fetchBeacon(round);
  }
  return b;
}

test("the hard-coded chain parameters match drand's own info endpoint", { skip: !online }, async () => {
  assert.equal(info.hash, L.CHAIN.hash);
  assert.equal(info.period, L.CHAIN.period);
  assert.equal(info.genesis_time, L.CHAIN.genesis);
  assert.equal(info.public_key, L.CHAIN.pub);
  console.log("    chain " + info.hash.slice(0, 16) + "… · period " + info.period + "s · public key matches");
});

test("three relays agree on a published round, and randomness = SHA256(signature)", { skip: !online }, async () => {
  const round = L.roundOf(Date.now() / 1000) - 2;
  const b = await beaconAt(round);
  assert.ok(b.ok, "relays disagreed: " + JSON.stringify(b.relays.map((r) => [r.host, r.status])));
  assert.ok(b.agree >= 2, "only " + b.agree + " relays agreed");
  assert.match(b.randomness, /^[0-9a-f]{64}$/);
  assert.match(b.signature, /^[0-9a-f]{96}$/);
  assert.equal(L.toHex(await L.sha256js(L.fromHex(b.signature))), b.randomness);
  console.log("    round " + round + " · " + b.agree + "/" + b.total + " relays agree · " +
    L.utc(L.timeOfRound(round)) + " · randomness " + b.randomness.slice(0, 16) + "…");
});

test("a full lottery, drawn from a real beacon and audited end to end", { skip: !online }, async () => {
  const round = L.roundOf(Date.now() / 1000) - 1;
  const b = await beaconAt(round);
  assert.ok(b.ok, "no beacon");
  const names = ["Ada", "Grace", "Alan", "Edsger", "Barbara", "Tony", "Margaret", "Ken"];
  const { code, sizes } = await L.encodeToken({
    type: "selection", k: 3, names: names,
    createdRound: round - 200, drawRound: round
  });
  const lot = await L.decodeToken(code);
  assert.equal(lot.drawRound, round);
  const res = await L.run(lot, b);
  const winners = res.order.map((i) => names[i]);
  console.log("    winners: " + winners.join(", ") + " · hash " + res.hash.slice(0, 16) + "… · code " +
    sizes.code + " chars from " + sizes.raw + " bytes");

  /* whoever receives the code and the beacon must reach the same conclusion */
  const proof = {
    engine: L.TAG, token: code, tokenHash: await L.tokenHash(lot.raw),
    lottery: { kind: lot.type, n: lot.n, k: lot.k, createdRound: lot.createdRound, drawRound: round },
    beacon: { chain: L.CHAIN.name, round: round, randomness: b.randomness, signature: b.signature },
    result: { hash: res.hash, order: res.order }
  };
  const audit = await L.verify(code, b, res.hash);
  assert.ok(audit.checks.every((c) => c.ok), JSON.stringify(audit.checks.filter((c) => !c.ok)));
  assert.equal(audit.result.hash, res.hash);

  /* the same check, offline, from the proof alone */
  const pasted = L.parseBeacon(JSON.stringify(proof));
  assert.equal(pasted.round, round);
  assert.equal(pasted.randomness, b.randomness);
  const offline = await L.verify(proof.token, pasted, proof.result.hash);
  assert.ok(offline.ok, "offline verification failed");
  assert.deepEqual(offline.result.order, res.order);

  /* a tampered result hash must be caught */
  const tampered = await L.verify(proof.token, pasted, "00".repeat(32));
  assert.equal(tampered.ok, false);
  /* a tampered token must be caught before anything else */
  const broken = await L.verify(proof.token.slice(0, -3) + "AAA", pasted, null);
  assert.equal(broken.ok, false);
  assert.equal(broken.lot, null);
});

test("a round in the future is reported as not published, with HTTP 425", { skip: !online }, async () => {
  const future = L.roundOf(Date.now() / 1000) + 500;
  const b = await L.fetchBeacon(future);
  assert.equal(b.ok, false);
  assert.ok(b.notYet, "expected every relay to say 'not published yet', got " + JSON.stringify(b.relays.map((r) => r.status)));
});
