## 2026-08-12 -- Agent canvas P2 (#256): rounds 3-5 of adversarial hardening

Two more adversarial rounds ran against the semantic snapshot, and the governing
fact is what they found rather than what they fixed: **three consecutive rounds
each found the PREVIOUS round's fix defective.** Round 4 attacked round 3's
patches and broke two of them. The work below closes what round 4 left open.

The pattern is worth naming, because it kept repeating in the same shape: a fix
that bounds one thing while a later stage multiplies it.

### The two blockers, both self-inflicted

**NFKC-before-cap was a renderer OOM.** Round 3 moved `.normalize('NFKC')` ahead
of the length cap in `str()` to kill a RangeError in the serializer. That put an
18x expansion in front of a `max * 24` prefix -- an effective `max * 432` bound
-- running ~85 times per node on the renderer's UI thread. 36 KB of page killed
the window, 3/3 runs; the code it replaced survived the same payload in 10 ms.

Three parts were needed. Normalise a PREFIX and cap AFTER the expansion, growing
the prefix rather than fixing it, because NFKC also CONTRACTS (Hangul L+V+T is
3 code units to 1; astral folds to BMP) and a flat prefix clips such a string a
third short of its cap. Detach the result -- V8 answers `slice()` with a view
that keeps the whole parent alive, and wrapping it in a concatenation does not
release it either. Memoise string fields per owning record, because structured
clone preserves identity: one node object referenced 4,000 times cost the page a
single string and cost us 4,000 normalisations of it.

**Nothing bounded the result's TOTAL size.** Per-node caps multiply: 4,000 nodes
each legally carrying a name, a uxId, 20 issues and 24 styles is ~49.5 M
characters, of which the serializer emits at most 512,000. A total-character
budget now sits beside the node budget. Its accounting charges the JSON
structure around each value, not only the value -- twenty issues with empty
values are ~1,150 characters of key names and twenty of content -- and it is
kept tight, because a padded constant spends an honest page's budget on
punctuation it never sends.

### The rest

- **Field redaction discriminated in the wrong direction, both ways.** All five
  of round 3's widenings were unguarded (disabling any one left 230 canvas tests
  green), and the widened matching used unbounded substrings, so `key` hit
  `keywords` and `card` hit "Card title" -- 20 of 23 realistic fields redacted,
  which makes a card-authoring form unreviewable. Identifiers are now split into
  words first; the surfaces are split by how much evidence they carry (a `name`
  is a machine identifier, an `aria-label` is prose); and a prose surface that
  is NOTHING BUT a risky word is a field name, so `<label>PIN</label>` redacts
  and "Pin to top" does not.
- **The snapshot was budgeted in the wrong units.** The envelope escapes `&` and
  `<` after the serializer has finished counting, so a character charged as one
  reached the agent as up to five: 3.0x to 4.3x over the ceiling.
- **The axe join dropped findings it attributed upward.** It deduped on the rule
  alone, so three sibling wrappers with three different contrast ratios all
  reached the same ancestor and two were silently discarded. Findings now carry
  the offending descendant's box, so an ancestor is not a dead end.
- **The contrast arbitration read axe's silence as a verdict.** "Measurement
  covers what axe returned as incomplete" still assumes every element gets an
  answer; an element axe never evaluated gets none. Restated exhaustively: axe
  owns what it reached a verdict on, measurement owns everything else.

### On verification, which is the actual lesson

Round 3's commit message claimed every fix was verified fail-first. For the
redaction cluster that was false. So each fix here records what was fail-first
and what was not, and every defence was mutation-tested rather than assumed.

That caught four defects in this session's own work:

- The accounting fuzz used a textbook LCG whose low bit has a period of two, so
  its "is this field present?" draws were locked together and no issue-heavy
  node was ever generated. Deleting the issue accounting outright left it green.
- Its slack allowance was one maximal node, which hid six undercharges. An
  undercharged FIELD is paid on every node that fits, so the test is sharp only
  when many small nodes fit -- not when few large ones do.
- An `axeReset` test used `{ rules: [{ id, enabled: false }] }`, which fails
  whether or not the reset happens because the run pins its rule set with
  `runOnly`. It asserted a property that holds for an unrelated reason.
- A mutation that only inserted a comment, leaving the try/catch it claimed to
  remove in place. A mutation that does not mutate reads exactly like a guarded
  defence.

### Deliberately not done

- `text-indent: -9999px` is not treated as hidden: it moves only the first line,
  so honouring it would let a page suppress findings on text still on screen.
- A closed `<details>` is unsettled -- it needs a real layout engine, and CI has
  none.
- The label-text memo stays although no test kills it: it closes an asymmetry
  that is a property of the DOM (`textContent` rebuilds the subtree string on
  every read) and not of jsdom, whose textContent is far cheaper than a real
  engine's. Kept for the asymmetry, claimed as nothing more.
- Pre-existing bounds that round 4 also found unguarded -- the bridge's own
  `MAX_NODES`/`MAX_DEPTH`, the overlap caps, the `isSrOnly` ancestor depth --
  are a follow-up issue, not this PR.

### Follow-up

`tests/unit/hooks/hooks-gateway-wire.test.ts` flakes under full-suite load; it
binds a real loopback port. Green on re-run and 3/3 in isolation. Unrelated to
this work.
