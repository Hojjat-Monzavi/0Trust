/* crosscheck.mjs — build tokens with the engine and hand them to the Python spec
   implementation (tests/oracle_check.py) to prove the code is portable both ways. */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const L = createRequire(import.meta.url)("../src/engine.js");
const te = new TextEncoder();
const beaconOf = (s) => L.toHex(L.sha256js(te.encode(s)));
const names = (n) => Array.from({ length: n }, (_, i) => "p" + i);

const CASES = [
  ["selection-3-of-50", { type: "selection", k: 3, names: names(50) }],
  ["selection-k-equals-n", { type: "selection", k: 12, names: names(12) }],
  ["selection-replacement-40", { type: "selection", k: 40, replacement: true, weights: [1, 2, 0, 5, 5, 1, 1, 1, 1, 1, 9, 1], names: names(12) }],
  ["selection-weighted", { type: "selection", k: 5, weights: [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8], names: names(12) }],
  ["selection-unicode", { type: "selection", k: 2, names: ["Ævar", "北京", "🎲", "مرحبا", "e\u0301t"] }],
  ["selection-duplicates", { type: "selection", k: 2, names: ["Sam", "Sam", "Sam", "Sam"] }],
  ["selection-empty-name", { type: "selection", k: 1, names: ["", "b"] }],
  ["selection-one", { type: "selection", k: 1, names: ["only"] }],
  ["ranking-30", { type: "ranking", names: names(30) }],
  ["ranking-1", { type: "ranking", names: ["solo"] }],
  ["ranking-500", { type: "ranking", names: names(500) }],
  ["distribution-300-in-7", { type: "distribution", k: 7, names: names(300) }],
  ["distribution-weighted-11", { type: "distribution", k: 3, weights: [1, 1, 1, 5, 1, 1, 1, 1, 40, 1, 1], names: names(11) }],
  ["distribution-one-group", { type: "distribution", k: 1, names: names(6) }],
  ["allocation-1000-of-16", { type: "allocation", k: 1000, weights: [1, 3, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59], names: names(16) }],
  ["allocation-equal", { type: "allocation", k: 7, weights: [1, 1, 1], names: names(3) }],
  ["allocation-zeros", { type: "allocation", k: 9, weights: [0, 1, 0, 3], names: names(4) }],
  ["allocation-one-participant", { type: "allocation", k: 5, weights: [4], names: ["alone"] }],
  ["allocation-ties", { type: "allocation", k: 100, weights: [1, 1, 1, 1, 1, 1, 1], names: names(7) }],
  ["long-name-2000", { type: "ranking", names: ["x".repeat(2000), "short"] }]
];

const out = [];
for (const [name, spec] of CASES) {
  const n = spec.names.length;
  const createdAt = 100000 + out.length;
  const lot = Object.assign({ createdRound: createdAt, drawRound: createdAt + 250, k: n }, spec);
  const { code } = await L.encodeToken(lot);
  const back = await L.decodeToken(code);
  const randomness = beaconOf("crosscheck:" + name);
  const res = await L.run(back, { round: back.drawRound, randomness: randomness });
  out.push({
    name: name,
    code: code,
    raw: L.toHex(back.raw),
    round: back.drawRound,
    randomness: randomness,
    hash: res.hash,
    vector: back.type === "allocation" ? res.shares : res.order
  });
}

writeFileSync(new URL("./out_node.json", import.meta.url), JSON.stringify(out, null, 1));
console.log("wrote out_node.json — " + out.length + " engine-built tokens for the Python checker");
