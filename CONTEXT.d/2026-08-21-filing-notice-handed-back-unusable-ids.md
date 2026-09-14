# 2026-08-21 — The filing notice handed the agent ids no tool could address

Third of the carried #308 ADR-009 findings. Diagnosed, then attacked to refute
it; the refuter could not, and the mechanism below is its account as much as the
first one's.

## Why the ids were unusable

Review ids are **per canvas**. `recordFor` starts every canvas at
`nextReview: 1` and mints `R${nextReview}`, so every canvas has an R1, an R2,
and so on.

`canvas_render` with a title naming a different subject files the canvas the
user was on and activates another. The reply then read the FILED canvas's counts
and said ` It still has open notes on R1, R2.`

But `canvas_review` resolves nothing from that sentence. It **rejects** any
`canvasId` the model supplies that is not the active one — a deliberate
fail-closed check — and then looks the review id up against
`canvasForSession(sessionId)`, i.e. the canvas that is active NOW. Two outcomes:

- **New canvas.** No record, so the agent is told "this canvas has no submitted
  reviews yet" — flatly contradicting the sentence it just read. The filed
  canvas's open notes are unreachable to it entirely.
- **Returned-to canvas** (`"Login page"` → `"Checkout"` → `"Login page"`, which
  re-activates the login canvas). R1 exists on both, so it returns the ACTIVE
  canvas's R1 as a normal success — different notes, different version, no
  canvas id anywhere in the envelope to give it away. The agent then works on
  feedback the user wrote about a different mockup, and a follow-up
  `canvas_resolve R1` marks THAT canvas's notes addressed. The user's real notes
  stay open; notes they never asked about get closed.

## The fix

The notice reports a **count** and says where the notes are:
` It still has 2 review(s) with open notes, on that filed canvas rather than this
one — the user reopens it from the Canvas library.` An id no tool can address is
worse than no id.

Deliberately NOT fixed by widening `canvas_review` to accept a filed canvasId —
that guard is a fail-closed authorization check against a model-supplied id, and
this is not a good enough reason to open it.

Two adjacent corrections came with it:

- **`renderVersion` now reports `returnedToExisting`.** The reply said "this is a
  new canvas" on both paths, and on the comeback path that is false — the canvas
  being re-activated already has versions and notes. The store is the only place
  that knows which happened, so it says so.
- **`markAnnotationsAddressed`'s comment claimed review ids name a canvas.** They
  do not, for exactly the reason above. What actually bounds a mis-aimed resolve
  is that the id can only resolve against the ACTIVE canvas, plus the membership
  check on `annotationIds` — so it must collide on the review number AND the
  annotation ids to do anything. The comment now says that instead of the thing
  that is not true.

## Verification

Full suite **6283 passed / 15 skipped**, typecheck clean.

| mutation | result |
| --- | --- |
| emit `listIds(openReviewIds)` in the notice again | 1 red |
| `returnedToExisting` hard-coded false in the store | 1 red |
| the tool ignores the flag and always says "new canvas" | 1 red |

## Also examined, and NOT defects

Two of the six carried items did not survive their own scrutiny, so nothing
changed for them, and they should not be re-filed:

- **`canvas-handlers.ts:253`'s scoping comment.** Its claim is qualified — "the
  caller cannot ask to see another project's list *by naming its path*" — and
  `listAllSchema` is `.strict()` with both fields bounded by a charset holding no
  `/`, `\`, `:` or `.`, so no path can be spelled. The wider property (that the
  list is confined) is not claimed there and is explicitly denied five times in
  the same call path, including on the schema two lines above and in ADR-017.
- **`canvas:listAll`'s review sweep.** Bounded already: `MAX_REVIEW_SWEEP` caps
  non-own canvases, the file gate caps each read at 8 MiB, and the realistic
  whole-library sweep is ~70 files of single-digit KB. The residual is a byte
  ceiling reachable only with ~100,000 hand-authored notes, with no
  agent-reachable route to create them (the MCP surface can only READ notes).
  Left alone. Three genuinely adjacent observations were logged for later: the
  `annotations` array has no length cap where `reviews` does; the count path is
  uncached and re-sweeps whenever ANY session opens or closes; and
  `MAX_CANVASES_PER_SESSION` is enforced in one branch only, so `ensureDiskScanned`
  can exceed it.
