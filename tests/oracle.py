#!/usr/bin/env python3
"""Independent re-implementation of the LOTTO/1 spec, written from src/spec.html only.

It generates tests/vectors.json: for every case the canonical token *bytes*, a full
L1- code (compressed with zlib, so the JS side must swallow a foreign deflate stream)
and the expected draw for two fixed beacons.

Nothing here is shared with the JavaScript: if both implementations agree on the
vectors, the spec is unambiguous enough for a third party to re-implement.
"""
import base64
import hashlib
import json
import os
import zlib

TAG = b"LOTTO/1"
U32 = 1 << 32
KIND = {"selection": 0, "ranking": 1, "distribution": 2, "allocation": 3}
KIND_BY_ID = {v: k for k, v in KIND.items()}
HERE = os.path.dirname(os.path.abspath(__file__))


def sha(b):
    return hashlib.sha256(b).digest()


def u32(n):
    return n.to_bytes(4, "big")


def varint(v):
    out = bytearray()
    while True:
        b = v & 127
        v //= 128
        if v:
            out.append(b | 128)
        else:
            out.append(b)
            return bytes(out)


def pack(lot):
    names, n = lot["names"], len(lot["names"])
    k = n if lot["kind"] == "ranking" else lot["k"]
    w = lot.get("weights")
    W = bool(w) and any(x != 1 for x in w)
    out = bytearray([1, KIND[lot["kind"]], (1 if W else 0) | (2 if lot.get("replacement") else 0)])
    out += u32(lot["createdRound"]) + u32(lot["drawRound"]) + u32(k) + u32(n)
    for nm in names:
        b = nm.encode("utf-8")
        out += varint(len(b)) + b
    if W:
        for x in w:
            out += varint(x)
    return bytes(out)


def code_of(raw):
    co = zlib.compressobj(9, zlib.DEFLATED, -15)
    comp = co.compress(raw) + co.flush()
    body = base64.urlsafe_b64encode(comp + sha(comp)[:4]).decode().rstrip("=")
    return "L1-" + body, comp


def unpack(raw):
    """Spec decoder: used to check tokens produced by the JavaScript side."""
    o = 3
    ver, ti, flags = raw[0], raw[1], raw[2]
    assert ver == 1, "version"
    created, draw, k, n = (int.from_bytes(raw[o + 4 * i:o + 4 * i + 4], "big") for i in range(4))
    o += 16
    names = []
    for _ in range(n):
        v, shift = 0, 0
        while True:
            c = raw[o]
            o += 1
            v += (c & 127) << shift
            if not c & 128:
                break
            shift += 7
        names.append(raw[o:o + v].decode("utf-8"))
        o += v
    weights = None
    if flags & 1:
        weights = []
        for _ in range(n):
            v, shift = 0, 0
            while True:
                c = raw[o]
                o += 1
                v += (c & 127) << shift
                if not c & 128:
                    break
                shift += 7
            weights.append(v)
    assert o == len(raw), "trailing bytes"
    return {"ver": ver, "kind": KIND_BY_ID[ti], "replacement": bool(flags & 2),
            "createdRound": created, "drawRound": draw, "k": k, "n": n,
            "names": names, "weights": weights}


def decode_code(code):
    body = code[3:]
    b = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
    comp, chk = b[:-4], b[-4:]
    assert sha(comp)[:4] == chk, "checksum"
    return zlib.decompressobj(-15).decompress(comp)


class Stream:
    def __init__(self, seed):
        self.seed, self.i = seed, 0

    def word(self, i):
        b = sha(self.seed + u32(i // 8))
        o = (i % 8) * 4
        return int.from_bytes(b[o:o + 4], "big")

    def rand(self, n):
        limit = U32 - (U32 % n)
        while True:
            w = self.word(self.i)
            self.i += 1
            if w < limit:
                return w % n


def draw(lot, randomness):
    st = Stream(sha(TAG + lot["raw"] + bytes.fromhex(randomness)))
    n, kind = lot["n"], lot["kind"]
    w = lot.get("weights")

    if kind == "allocation":
        k = lot["k"]
        weights = w or [1] * n
        total = sum(weights)
        base = [(k * weights[i]) // total for i in range(n)]
        frac = [(k * weights[i]) % total for i in range(n)]
        r = k - sum(base)
        if r <= 0:
            return base
        order = sorted(range(n), key=lambda i: (-frac[i], i))
        cut = frac[order[r - 1]]
        lo = r
        while lo > 0 and frac[order[lo - 1]] == cut:
            lo -= 1
        hi = r
        while hi < n and frac[order[hi]] == cut:
            hi += 1
        for i in range(lo):
            base[order[i]] += 1
        group, need = order[lo:hi], r - lo
        if need:
            if len(group) <= need:
                for g in group:
                    base[g] += 1
            else:
                keys = sorted((st.rand(U32), g) for g in group)
                for _, g in keys[:need]:
                    base[g] += 1
        return base

    if not w:
        p = list(range(n))
        for i in range(n - 1, 0, -1):
            j = st.rand(i + 1)
            p[i], p[j] = p[j], p[i]
        return p[: lot["k"]] if kind == "selection" else p

    plays = n if kind == "distribution" else lot["k"]
    rem, ww = list(range(n)), list(w)
    total = sum(ww)
    picks = []
    for _ in range(plays):
        r = st.rand(total)
        acc, idx = 0, 0
        for i, ix in enumerate(rem):
            acc += ww[ix]
            if r < acc:
                idx = i
                break
        it = rem[idx]
        picks.append(it)
        if not lot.get("replacement"):
            total -= ww[it]
            ww[it] = 0
            rem.pop(idx)
    return picks


def result_hash(lot, vec):
    return sha(TAG + bytes([KIND[lot["kind"]]]) + u32(lot["drawRound"]) + b"".join(u32(x) for x in vec)).hex()


CASES = [
    ("selection-3-of-5", dict(kind="selection", k=3, names=["Ada", "Grace", "Alan", "Edsger", "Barbara"])),
    ("selection-single", dict(kind="selection", k=1, names=["Only One"])),
    ("selection-everybody", dict(kind="selection", k=5, names=["A", "B", "C", "D", "E"])),
    ("selection-replacement", dict(kind="selection", k=11, replacement=True, weights=[3, 1, 4, 1], names=["a", "b", "c", "d"])),
    ("selection-weighted", dict(kind="selection", k=4, weights=[1, 2, 3, 4, 5], names=["w1", "w2", "w3", "w4", "w5"])),
    ("selection-zero-weight", dict(kind="selection", k=2, weights=[0, 7, 1], names=["never", "often", "rare"])),
    ("selection-ones", dict(kind="selection", k=2, weights=[1, 1, 1, 1], names=["p", "q", "r", "s"])),
    ("ranking-6", dict(kind="ranking", names=["u1", "u2", "u3", "u4", "u5", "u6"])),
    ("ranking-1", dict(kind="ranking", names=["solo"])),
    ("ranking-2", dict(kind="ranking", names=["first", "second"])),
    ("distribution-7-in-3", dict(kind="distribution", k=3, names=list("abcdefg"))),
    ("distribution-6-in-4", dict(kind="distribution", k=4, names=list("abcdef"))),
    ("distribution-weighted", dict(kind="distribution", k=2, weights=[5, 1, 1, 1, 1, 1], names=["w1", "w2", "w3", "w4", "w5", "w6"])),
    ("allocation-10-of-1234", dict(kind="allocation", k=10, weights=[1, 2, 3, 4], names=["x1", "x2", "x3", "x4"])),
    ("allocation-equal", dict(kind="allocation", k=7, weights=[1, 1, 1], names=["e1", "e2", "e3"])),
    ("allocation-lopsided", dict(kind="allocation", k=3, weights=[10, 1, 1, 1, 1], names=["big", "s1", "s2", "s3", "s4"])),
    ("allocation-one-unit", dict(kind="allocation", k=1, weights=[1, 1, 1], names=["a", "b", "c"])),
    ("allocation-zero-weights", dict(kind="allocation", k=5, weights=[0, 5, 0], names=["z1", "z2", "z3"])),
    ("allocation-exact-share", dict(kind="allocation", k=4, weights=[1, 1, 1, 1], names=["q1", "q2", "q3", "q4"])),
    ("unicode-names", dict(kind="selection", k=2, names=["Ævar Ægir", "北京市", "🎲🎲", "مرحبا", "e\u0301toile"])),
    ("duplicate-names", dict(kind="selection", k=2, names=["Sam", "Sam", "Sam"])),
    ("long-name", dict(kind="ranking", names=["L" * 1000, "short"])),
    ("empty-name", dict(kind="selection", k=1, names=["", "b"])),
    ("max-weight", dict(kind="selection", k=1, weights=[4294967295], names=["max weight"])),
    ("trailing-space-name", dict(kind="distribution", k=2, names=[" a", "a ", "a"])),
]


def build():
    out = []
    for i, (name, spec) in enumerate(CASES):
        names = spec["names"]
        n = len(names)
        weights = spec.get("weights")
        stored = weights if weights and any(x != 1 for x in weights) else None
        lot = dict(kind=spec["kind"], k=n if spec["kind"] == "ranking" else spec["k"],
                   names=names, weights=weights, replacement=spec.get("replacement", False),
                   createdRound=1000 + i, drawRound=1000 + i + 250)
        raw = pack(lot)
        code, comp = code_of(raw)
        core = dict(lot, n=n, raw=raw, weights=stored)
        draws = {}
        for tag in ("beacon-a", "beacon-b"):
            r = sha((name + "|" + tag).encode()).hex()
            vec = draw(core, r)
            draws[tag] = {"randomness": r, "vector": vec, "hash": result_hash(core, vec)}
        out.append({
            "name": name, "kind": lot["kind"], "k": lot["k"], "n": n, "names": names,
            "weights": stored, "replacement": lot["replacement"],
            "createdRound": lot["createdRound"], "drawRound": lot["drawRound"],
            "raw": raw.hex(), "code": code, "codeLength": len(code), "deflated": len(comp),
            "draws": draws,
        })
    return out


if __name__ == "__main__":
    vectors = build()
    with open(os.path.join(HERE, "vectors.json"), "w", encoding="utf-8") as f:
        json.dump(vectors, f, ensure_ascii=False, indent=1)
    print("wrote vectors.json — %d cases, %d bytes of codes" % (len(vectors), sum(v["codeLength"] for v in vectors)))
