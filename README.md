# LOTTO/1

A verifiable lottery in **one static HTML file**. No server, no accounts, no
dependencies. The organiser compiles a token that carries the whole lottery —
participants, kind, and the exact time of the draw — and hands it out as a link.
Everyone draws the same result from the same public randomness, and anyone can
check it.

```
lotto/dist/index.html      ← the deliverable (open it, or put it on a web host)
```

**Live:** <https://hojjat-monzavi.github.io/0Trust/> — append `?t=<code>` to run a
specific lottery.

The randomness comes from the [drand](https://drand.love/developer/) **quicknet**
beacon: a threshold signature network that publishes a signed random value every
3 seconds. The draw uses the value published at a round that the token fixes in
advance. Nobody — including the organiser — can influence it.

---

## The three stages

1. **Compile** — pick the kind, the participants (and optional weights), and the
   draw time. The page compresses all of it into a short `L1-…` code.
2. **Draw** — open the link. When the chosen beacon round has been published, the
   page fetches it from three independent drand relays, requires at least two of
   them to agree, and computes the result.
3. **Verify** — paste a code and either let the page fetch the beacon again, or
   paste a saved beacon/proof to check everything completely offline.

**Publish the link at least 10 minutes before the draw.** The token records a
creation round and a draw round, and the page refuses to treat a draw as
rule-compliant unless the gap is ≥ 200 rounds (10 minutes at 3 s per round). A
token that breaks the rule still draws and verifies — it is flagged instead of
silently rejected, so a broken rule can always be audited. See *Honest
limitations* below: the creation round is self-reported.

## The four kinds

| Kind | What it does | `k` means |
| --- | --- | --- |
| **Selection** | Picks `k` winners. | winners |
| **Ranking** | Orders every participant. | (ignored; all are ranked) |
| **Distribution** | Splits everyone into `k` groups, larger groups first. | groups |
| **Proportional allocation** | Shares out `k` whole units in proportion to weights. | units |

Options: *with replacement* (a participant can be drawn more than once) and
*weights* (a participant's chance is their weight over the total; weight 0 can
never be drawn). Allocation needs weights — with equal weights it splits the
units as evenly as whole units allow. A weighted ranking is refused on purpose:
a full weighted ordering is quadratic, and the alternative would be a lottery
that quietly takes minutes to draw.

---

## Why it is verifiable

* **The draw is a pure function of the token and the beacon.** The seed is
  `SHA256("LOTTO/1" ‖ tokenBytes ‖ beaconRandomness)`. Every random number comes
  from `SHA256(seed ‖ counter)`, consumed as unbiased 32-bit words with
  rejection sampling. There is no floating point anywhere in the draw, no clock,
  no `Math.random`, no ordering that depends on the machine.
* **The randomness is public and signed.** The page checks
  `SHA256(signature) == randomness` itself, and cross-checks three relays. For
  the full BLS threshold proof, verify the beacon with the
  [drand docs](https://drand.love/developer/) — the page does not carry a BLS
  verifier (it deliberately trades that for staying small).
* **The result is committed.** The page prints a SHA-256 of the whole result, and
  the same hash appears in the proof file. Two implementations that follow the
  frozen spec (printed at the foot of the page) agree byte for byte.

The page never sends anything anywhere. The only network requests it makes are
`GET https://api{drand.sh,2,3}.drand.sh/public/<round>`.

---

## The code format

The token is `L1-` + base64url of:

```
[ deflate-raw(binary) ][ SHA-256(deflate-raw(binary))[0..3] ]
```

and the binary is a fixed little wire format:

```
version:u8 | kind:u8 | flags:u8 | createdRound:u32be | drawRound:u32be
| k:u32be | n:u32be | n × (varint length + UTF-8 name) | [if weighted] n × varint weight
```

The checksum covers the *compressed* bytes, so any damage is caught before
parsing. The **token hash** — the identity of a lottery — is the SHA-256 of the
*decompressed* bytes, so it does not depend on the compressor. A token built by
another conforming implementation with a different deflate implementation is
accepted and hashes to the same value.

Round arithmetic is fixed by the chain: `round(t) = ⌊(t − 1692803367) / 3⌋ + 1`
for Unix time `t`.

## Limits

`n ≤ 100000` participants, names ≤ 4096 bytes each, `k ≤ 1000000`, weights
≤ 2³²−1, code ≤ 2 MiB, decompressed token ≤ 8 MiB. Weighted draws are capped at
`n·k ≤ 200 000 000` and a weighted order of 10000, and the cap is enforced when
*a code is read*, not only when it is written, so a hostile token cannot stall a
verifier. A 100 000-participant ranking takes about 3 seconds and produces a code
far too long for a URL — large lotteries should be distributed as a file or in
the page body.

---

## Honest limitations

* **The 10-minute rule is a discipline, not a proof.** `createdRound` is chosen
  by the organiser when compiling and can be back-dated. What cannot be faked is
  the result: it is a function of a beacon round that only exists after its time.
  Judge honesty by *when the link was published* (chat logs, mailing lists, git),
  not by the number in the token.
* **You need two of three drand relays.** If a participant's network blocks two
  of them, they cannot draw locally. All three agree in normal operation, and a
  third party can always supply the beacon out of band. A relay that accepts the
  connection and then goes quiet is given 12 seconds and then treated as absent,
  so a bad network shows an error instead of a frozen page.
* **BLS is checked by cross-relay agreement, not by pairing.** The page checks the
  beacon's hash-to-signature relation and requires two independent relays to
  return identical `randomness` and `signature`; a full threshold verification is
  left to external drand tooling.
* **Nothing is private.** The participant list and every weight are in the token,
  which travels in a URL. Names must be things you are willing to publish.

---

## Tests

Everything runs offline except the last two.

```sh
cd lotto
npm run oracle      # build tests/vectors.json with the independent Python implementation
npm test            # 33 tests: primitives, wire format, draw maths, fuzz, artifact checks
npm run crosscheck  # engine → Python: 20 engine-built tokens redrawn identically in Python
npm run build       # inline src/* into dist/index.html, and refuse external resources
npm run test:live   # real drand: chain parameters, 3 relays agree, a real draw + audit
npm run test:browser# real Chrome/Edge on the shipped page (skips itself if relays are down)
npm run full        # all of the above, in order
```

What is actually being checked, beyond the obvious:

* **Two independent implementations.** `tests/oracle.py` implements the spec
  again in Python and builds 25 golden vectors; `tests/oracle_check.py` goes the
  other way and re-draws tokens the JS engine built. Both directions must agree
  byte for byte.
* **SHA-256.** The pure-JS hash (used by old browsers and by the tests) is
  compared against WebCrypto and against the published known-answer vectors.
* **Unbiasedness.** A chi-square test on the 24 permutations of 4 participants,
  and a bounds test on the rejection sampler.
* **The wire format's refusals.** Truncation, bit flips, appended bytes, 4000
  mutations, 30 000 random byte strings, and every structurally impossible
  header.
* **The artifact itself.** `dist.test.mjs` checks the built file has no external
  references, that every `id` the app reaches for exists in the markup, that the
  shipped engine is byte-identical to `src/engine.js`, and that the frozen spec is
  present.
* **The real browser.** `tests/browser.mjs` drives headless Chrome: it opens the
  page with a shared link, draws from live drand, builds the share link, and
  captures the proof file the UI produces — then re-verifies that proof offline
  through the paste path. A second load checks a lottery whose time has not come:
  the button is locked and a countdown is shown.

A skipped test is not a pass: the two network tests exit 0 with a warning when
the relays are unreachable, so re-run them.

## Files

```
lotto/
  src/engine.js       the whole spec: packing, hashing, the draw, verification
  src/app.js          the DOM layer and nothing else
  src/index.html      markup, with markers where the three pieces are inlined
  src/spec.html       the frozen specification printed at the foot of the page
  src/style.css       plain, formal, no framework
  build.mjs           inlines the pieces and fails on any external resource
  dist/index.html     the deliverable, built and committed
  tests/              see above
```

## Publishing

The site is live at <https://hojjat-monzavi.github.io/0Trust/>.

`dist/index.html` is a single self-contained file. `npm run build` writes it **and**
a byte-identical `docs/index.html`, which is what GitHub Pages serves (Pages can
only publish from a repository root or a `/docs` folder). The test suite fails if
those two files ever diverge, so the published page is always the tested page.

To update the live site:

```sh
npm run full                    # build + every test; this rewrites docs/index.html
git commit -am "…" && git push  # Pages redeploys itself, usually within a minute
```

Opening the file from disk (`file://`) works as well — the relays send
`Access-Control-Allow-Origin: *`, so a copy on a USB stick draws exactly like the
live site.

There is no warranty. If the outcome matters, run the tests and check the
beacon yourself.
