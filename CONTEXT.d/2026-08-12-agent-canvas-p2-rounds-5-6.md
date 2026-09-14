## 2026-08-12 -- Agent Canvas P2 (#256): adversarial rounds 5 and 6

Continues `2026-08-12-agent-canvas-p2-hardening.md` (rounds 3 and 4). Same PR,
same trust boundary: a hostile page's self-report travelling frame -> renderer
-> main -> an agent's context.

### The pattern that has held for six rounds

**Every round's fix has itself been defective, and the next round found it.**
Round 6 found three live blockers; round 6b, attacking the fixes for them,
found that one fix broke the thing it was protecting. This is now the most
reliable finding the review produces, and it is why the rule "never self-review
a security boundary" earns its keep here -- each round's attackers were
independent of the author of the code they attacked.

The three regressions this session's own fixes introduced:

- The overlap cap counted a dropped finding at the TOP of its loop, before the
  sweep break and the area tests, so a node with exactly N partners and one
  unrelated box below it was charged a drop that never happened. Worse than a
  wrong number: the trust boundary reserves a wire slot the instant a drop is
  declared, so a phantom drop DESTROYS a genuine finding to make room for a line
  saying a finding was lost.
- Lowering the per-node overlap cap from 20 to 8 was justified as "the severity
  trim will rescue the important finding anyway". True only when the node has
  something more severe; on a node whose findings are all overlaps it discarded
  up to twelve real ones.
- The sr-only containment guard compared painted BOXES, and `overflow: hidden`
  clips paint rather than the border box -- so the screen-reader-only link
  inside the standard 1x1 wrapper still measures its full natural 133x17,
  failed containment, and came back with two invented findings on content a
  browser does not paint. That is the P0 run-2 false positive the whole feature
  was gated on, reintroduced on the commonest accessibility idiom there is.

### Techniques that paid, and one that did not

**Mutation-test the fix, and prove the mutation landed.** Whole-file comparison,
not `includes()`: `4000 -> 4000000` leaves the original text as a prefix, so a
substring check reports "not applied" and the mutation is silently skipped. Two
guards were scored as untested for this reason before the harness was fixed.

**A guard no input can trip is worse than no guard.** `maxStyleEntries` was 24
against an eleven-name allowlist and could never bind; it is gone rather than
tuned. Two charges were removed for the same reason. Conversely, a mutation that
survives is not automatically a finding -- one was labelled equivalent in the
code (no skipped tag can have element children in a parsed document) rather than
have a test contorted around it.

**A test that measures the wrong quantity scores an attack as cheaper than the
honest case.** The guard written for the previous style-enumeration bug counted
`normalize` calls; the attack that beat it makes none, so it read as 193 calls
and 474 characters while blocking the UI thread for 479 ms.

**A fixture that encodes an impossible layout cannot fail.** The sr-only control
gave the child the wrapper's own 1x1 box. No engine produces that, and it is why
a fix that broke every real sr-only wrapper shipped green.

**Bounding the enumeration was the wrong fix; not enumerating was the right
one.** `Object.keys()` on a page-supplied "styles" value runs before any cap can
apply, and on a typed array it mints an index string per element -- 122 MB of
forged reply took 34 s and killed the window with a 4 GB heap. With an
eleven-name allowlist there is no reason to enumerate at all: eleven lookups by
name, measured at 0.0 ms for the same payload.

**Measure the claim the bound rests on.** NFKC's worst shrink is exactly 4:1 in
UTF-16 code units (U+1F82, a Greek vowel carrying three combining marks), found
by decomposing every code point rather than reasoned about. The prefix bound is
now derived from that, and a test pins the measurement so an ICU change fails
the build instead of quietly clipping names short.

**Check browser behaviour in a browser.** Legacy `clip` does clip a
`position: fixed` descendant and `clip-path` establishes a containing block --
both the opposite of what the spec reading suggested, and both the reason the
containment guard was over-generalised to three branches when only one needed
it.

### Design changes worth remembering

- **Findings that do not fit are now counted, not dropped.** Three passes
  contribute issues to one node and none knows what the others found, so the
  total is decided once, by severity, at the end. The bridge reports a NUMBER;
  the boundary mints the words (`issues-truncated`) and accepts no marker from
  the frame. The count must never over-claim -- see the phantom drop above.
- **A third limit got its own name.** The node cap drops nodes, the output
  ceiling stops the write-out, and the depth cap refuses to descend past 64
  levels -- which a page reaches routinely without losing anything. Reporting it
  as the node limit told every capture of a deeply-nested app that the tree was
  partial. It is also the only one of the three with a real answer, so its note
  gives it: scope deeper.
- **One decision about the delimiters, at last.** The format has two -- brackets
  open tokens, quotes contain names -- and for three rounds only one cleaner was
  hardened at a time. Both replace now.

### Verdict and what is still open

Round 6 closed at **FINDINGS**, quarantined, `needs-review` retained. Two
blockers remain unattempted, both cases where the tool reports success over
content it never looked at: Shadow DOM is invisible to the walk, to scoping and
to the axe join; and a gradient whose stops do not parse (Tailwind v4's `oklch`
tokens) is measured against the wrong backdrop and reported as PASSING. Thirteen
majors remain, mostly suppression reachable from ordinary markup and coverage
holes where a finding disappears with no count. An independent mutation campaign
scored the wider pipeline at 112 survivors of 291 with the suite green.

The full open list is in the round-6 verdict comment on the PR.
