#!/usr/bin/env python3
"""Check tokens built by the JavaScript engine against the Python spec implementation.

Run tests/crosscheck.mjs first. This is the other half of the cross-implementation
proof: the JS side validates Python-built vectors, this validates JS-built codes.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from oracle import code_of, decode_code, draw, pack, result_hash, unpack  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(HERE, "out_node.json"), encoding="utf-8") as f:
    cases = json.load(f)

checked = 0
for c in cases:
    raw = decode_code(c["code"])            # checksum + inflate, done by the spec decoder
    assert raw.hex() == c["raw"], c["name"] + ": bytes differ"
    lot = unpack(raw)                       # structural decode, asserts there are no trailing bytes
    assert lot["drawRound"] == c["round"], c["name"] + ": round"
    lot["raw"] = raw
    vec = draw(lot, c["randomness"])
    assert vec == c["vector"], c["name"] + ": vector\n  py " + str(vec[:12]) + "\n  js " + str(c["vector"][:12])
    assert result_hash(lot, vec) == c["hash"], c["name"] + ": result hash"
    # a token re-packed from the decoded fields must reproduce the same bytes
    assert pack(dict(lot, weights=lot["weights"])) == raw, c["name"] + ": repack"
    checked += 1

print("oracle_check: %d engine-built tokens decoded and redrawn identically in Python" % checked)
