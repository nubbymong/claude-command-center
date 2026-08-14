# 2026-08-12 — agent canvas P2, round 8: the last silent misses, and a mutation campaign over the whole pipeline

Follows `2026-08-12-agent-canvas-p2-rounds-5-6.md` and the round-7 hardening.
PR #256, branch `feat/agent-canvas-p2`.

## Two silent misses closed

**Text that paints outside the box its element reports.** `isVisible` asks an
ELEMENT for a border box, and both branches of the walk were gated on it — so
`display: contents` (no box at all, text laid out in the parent's flow) and a
zero-height box with the default `overflow: visible` (text painted fully outside
it) were refused a node for want of a box and then refused a measurement for the
same reason. `truncated`, `depthLimited` and `hiddenContent` all stayed unset, so
the capture reported success over text nobody had looked at. The owner branch's
`!meaningful` clause dropped the same text a second time whenever the container
happened to be a text leaf or a `<p>`.

Owners now carry the box their TEXT paints in, measured with a Range. Everything
that does not paint is still refused: `display: none` on its lack of boxes,
`visibility: hidden` explicitly (it keeps its layout, so its text measures as
painted), and a zero-sized box that clips — the accordion idiom, where reporting
contrast would invent a finding on content a browser does not paint.

**A bounded overlap scan that said nothing.** Two per-node budgets bound the
overlap rule and both ended a scan in silence: a node that ran out reported "no
overlap" in exactly the same words as a node whose neighbours were all checked.
The scan budget is the worse of the two — descendants are skipped for free by the
containment test, so a node can spend all 512 on boxes the rule was never going
to report and reach its genuine partner never, with no finding and no drop count.
An icon grid or a long list inside one card reaches it by accident.

`overlapLimited` now rides the same path as `depthLimited` and `hiddenContent`:
its own bit, minted at the boundary from a strict `=== true`, with its own note.
It claims only what is certainly true — boxes in that node's band went
uncompared — and NOT that any of them overlapped, which is exactly what was not
looked at. Deliberately not the node's `issuesDropped`: declaring a drop reserves
a wire slot for a lost finding, so declaring one that may not have happened
evicts a real finding to make room for the announcement.

## The whole-pipeline mutation campaign, re-run

231 guards across the fourteen pipeline files, generated mechanically (every
named numeric bound, every single-line `if (…) return/continue/break`, every
`.slice(0, N)` ceiling) so the coverage is not limited to the guards the author
remembers writing. **116 killed, 115 survived** — the same ratio round 6's
independent campaign reported, which is why it was worth re-running rather than
assuming the last round's fixes generalised.

Real gaps found and closed, all mutation-verified:

- the containment re-check on the SPA-fallback ENTRY (its twin on the direct
  path was pinned; this one was not) and the served-size ceiling on both
  branches of the `ccc-ux://` handler;
- nine guards whose removal INVENTS a finding, now in a suite of their own: a
  node overlapping its own descendant, a one-pixel brush counted as a collision,
  screen-reader-only and faded boxes measured as if painted, a spacer with no
  text, contrast measured on `opacity: 0`, `font-weight: bold` read as a parse
  failure (which moves the threshold from 3:1 to 4.5:1 and reports passing text
  as failing), clipping reported on a box that does not clip, and an unrelated
  axe VIOLATION handing axe the contrast question for that node so the
  measurement pass stands down and nobody reports the defect.

Every rule involved already had a test for the finding it produces. What none of
them had was a test for the case it must stay QUIET on — the half the P0 gate
rests on.

## What the surviving mutants are

Recorded rather than chased, because "survivor" is not "defect":

- **Colour-parser internals (34).** Clamps, NaN paths and gamut branches inside
  the CSS Color 4 parser that no fixture reaches. Several are genuinely
  unreachable from any input the pipeline can produce.
- **Layered fail-closed checks (≈20).** The `ccc-ux://` handler is wrapped in a
  catch that returns the same 404, so deleting an inner guard produces an
  identical observable. That is the design working, not a hole — but it does
  mean no single test isolates each layer.
- **Cosmetic curation (≈15).** Style-shorthand compaction and default-dropping
  in `curatedStyles`, which affect token cost and nothing else.
- **Caps masked by a later cap (≈10).** `MAX_OVERLAPS_PER_NODE` is one: the
  severity trim at the end reaches the same number, so raising it changes
  nothing observable.

Three are labelled as genuine equivalents in the source itself: a `normal`
weight keyword (parseInt is NaN and the fallback is 400 already), a zero
intersection area (a fraction of zero fails the threshold below it), and a
directory read on the fallback path (it throws, and the catch returns the same
404).

## Method notes

- **A test list built by globbing `canvas*` missed a whole file.**
  `ccc-ux-protocol.test.ts` never ran, so every confinement guard in the protocol
  handler looked unheld. Three of those "survivors" were real once the list was
  built from what each module's tests actually import; the rest were not. A
  mutation campaign is only as honest as its test list.
- **Two control fixtures were too mild to execute the line they were about.**
  The overlap-limit control was two overlapping boxes — with only those, the
  sweep's own break never runs (the loop runs off the end of the list instead),
  so a mutation raising the flag on that break went unnoticed. The first
  SPA-fallback link test used a file symlink and SKIPPED on Windows, which
  certifies nothing; a junction needs no privilege and runs everywhere.
- Both are the same failure as round 7's gamut and depth-cap fixtures, and both
  were caught by the mutation run rather than by the tests passing.

## Still open

- **CSS `content` / `::before` text is invisible to the tree and to contrast.**
  Deferred deliberately: reading it needs `getComputedStyle(el, '::before')` on
  the hot path, and jsdom does not implement pseudo-element computed style at
  all, so the positive path cannot be tested here — a stub would test the stub.
  It needs the real-browser acceptance run, which is the same gate the
  ten-seeded-defect run is waiting on.
- The overlap scan cap is still starvable at 512. No number removes that
  residual; what changed is that it is no longer silent.

## `canvas_render` — what actually made the feature testable

The store has been able to render versions since P1 and **nothing called it**.
The only registered tool was `canvas_snapshot`, which reads a canvas no agent had
any way to create — so the loop could never be closed by an agent, which is what
"the canvas is not locally testable" has meant all along. It was never the
snapshot work.

`canvas_render(mode, …)` is the argument boundary in front of the store's
existing (adversarially reviewed) validation, not a re-implementation of it:

- **`design`** takes a complete HTML document, served from the canvas's own
  origin under the design CSP. **`uat`** takes a directory the user has already
  allowed and serves the built app in it. Every call makes a new version.
- **The session comes from the transport and nowhere else** (#188). It matters
  more here than on the read side because this is a WRITE: a model-supplied
  session id would let a prompt-injected session push a document onto another
  session's canvas, where the user reads it as their own agent's work.
- **The store's messages are never relayed.** They are built from model-supplied
  arguments and from paths on this machine, and the reply lands OUTSIDE the
  untrusted envelope where it carries operator authority. Mapped to a closed
  vocabulary that keeps only the refusals a user can act on.
- **`buildLabel` is shape-checked, not length-capped** — the same reason `scope`
  had to be: a newline in a model-supplied argument forged a note line during
  the adversarial pass on the read side.
- The success line says the render is **not** the user seeing it. The hand-back
  is the protocol (§6.1); an agent told the page is on screen reports on a screen
  nobody opened and then snapshots the version before it.

16 mutations, 16 killed. Four survived the first pass and **all four were real
gaps in the tests rather than equivalents**: an unknown mode falls into the UAT
branch when its gate goes (so `plan` — a mode the spec has and the store does
not — would quietly serve a directory), and a refusal alone does not prove the
store was never reached; a truthy non-string `distRoot` slips past a falsiness
check and lands in `path.resolve`; and the success text was pinned only through
the tool DESCRIPTION, never the reply.

### The loop, end to end

`canvas_render` → store writes the version and emits a change → the IPC handler
pushes it to the renderer → the user opens the Canvas pane → `canvas_snapshot`
reads what a real engine laid out. `toolOn('canvas')` defaults on, so both tools
are advertised without configuration.

## `canvas_render` — the adversarial pass (ADR-009)

Content ingress on the Conductor MCP server, so it earned its own pass. The
author of the tool did not attack it: four independent attacker lenses
(injection/envelope-escape, session-binding/allowlist, blast-radius/fail-posture,
design/coverage/parity), then a second independent pass against the patched
code. **Verdict: PASS**, marker recorded on #256.

Two MAJORs, both fixed and regression-tested (each test verified to fail with
its fix reverted):

- **Fail-open on a persist failure.** `renderVersion` mutated the live maps —
  pushed the version, set it active, put the record in `canvases`/`sessionIndex`
  — and only THEN wrote `canvas.json`. A write failure (a held handle on the
  hot every-render file, ENOSPC, an indexer lock) left the caller with a
  rejected render while the store had already made the rejected document the
  ACTIVE, servable version, counter advanced. The IPC path that used this sink
  is trusted-renderer-only; `canvas_render` is what makes it reachable by a
  prompt-injectable agent, so a document the agent was told failed could be
  served to the user as its work. Fixed: the store persists a record built off
  to the side and commits to memory only once the write succeeds — a failure
  leaves the live maps untouched, at worst orphaning a `versions/<vid>/` dir no
  record references. `setActiveVersion` carried the same ordering (benign — it
  only ever toggles between already-servable versions, and self-heals on
  restart — but the two writers should not disagree about durability); given the
  same treatment.
- **No byte cap at the untrusted ingress.** The design branch checked only
  non-empty-string, leaning on the store's 8 MB backstop while the trusted IPC
  path caps at 2 MB — the model-driven tool was the widest of the three
  ingresses to one store, with no rate limit. Fixed: fails closed at 2 MB,
  measured in bytes (not chars — the multi-byte case is the one a `.length`
  check gets wrong), before the store is touched.

Plus a MAJOR doc defect — a security comment and the tool description claimed
`buildLabel` was echoed back outside the untrusted envelope; it is write-only
(validated, stored on the version, surfaced nowhere yet). In these files the
comments are the threat-model of record, so a false one is a trap: a future echo
or a relaxed shape would reintroduce the injection the shape exists to stop.
Corrected to match behaviour; the guard stays.

Method note the re-attack earned: one of the first-round regression tests drove
the sink with a THROWING dep, so `isError` was true whether the cap fired or the
throw did — it proved nothing about which guard acted. A RECORDING dep that
asserts the sink was never reached is the discriminating shape. The re-attack
caught it; it was rewritten.

Non-blocking, surfaced by the pass and left for the owner: `uat` mode is
advertised but currently inert — `registerCanvasUatRoot` is wired nowhere in
production, so every UAT render is refused (fail-closed, safe). It cannot
succeed until the session→project-directory wiring lands.
