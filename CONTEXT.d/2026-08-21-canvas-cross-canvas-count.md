# 2026-08-21 — Canvas: the count that spans canvases (item 29, the deferred half)

Backlog item 29, "the dimensions problem". The 2026-08-20 dimensions mockup
(`canvas-dimensions-2026-08-20.html`, owner-approved) shipped in #308: the pane
names its subject, a subject picker (a menu), the filing strip, reviews grouped
into rounds with "Approve the remaining N", and a per-canvas open-review count
on the pane and the Canvas button. One piece was deliberately deferred there —
"Bigger — a count that spans canvases … worth doing, not worth doing first" —
and the owner's stated likely want was "every canvas this session authored".
This is that piece. No re-mock: the design was approved with it named.

## What changed

- **`canvasTotalsStore`** (new, renderer): per session `{ canvases, openReviews,
  withOpenReviews, unknown, onActive }`, folded from `canvas:listAll`. No new
  IPC: the listAll handler already joins `openReviewCount` onto every entry the
  asking session owns (its sweep is bounded only for OTHER sessions' canvases).
  `unknown` counts owned canvases whose review store could not be read — main
  leaves those `undefined`, never 0, and the UI must not call them clear.
- Hydrated lazily the first time a session's Canvas button mounts (same pattern
  as the review mirror), then kept live by BOTH pushes — `canvas:changed` in
  `setupCanvasListener` and `canvas:reviewChanged` in `setupCanvasReviewListener`
  — debounced 150 ms because a submit fires both within a millisecond.
- **Canvas button pill** = the session-wide total. Shows from TWO on this canvas
  (unchanged rule) OR from ONE when any of it is elsewhere, because that one is
  invisible from the terminal and the pill is the only way to learn it exists.
  Tooltip splits it ("4 reviews still open across 3 canvases — 1 on this one, 3
  elsewhere (open the subject picker to see which)") and names unreadable
  canvases. The live mirror wins for the on-screen canvas when it is fresher
  than the sweep (`max`).
- **Pane header**: a muted `+N elsewhere` chip beside this canvas's peach count,
  pointing at the subject picker (which already lists each canvas with its own
  count and "clear").

## Verification

`npm run typecheck` clean. New suites `stores/canvasTotalsStore` (fold, ownership
filter, unknown≠zero, failed read keeps what was known, debounce) and
`renderer/canvas-cross-canvas-count` (pill total, the from-one-elsewhere rule,
mirror-wins, unreadable wording, lazy hydrate once, both pushes reach the sweep
and a burst collapses). **Mutation pass 7/7** red (`mutate2.py`).

## Cost

One `listAll` per session on first button mount, then one per canvas/review
push for that session. listAll reads every canvas dir in the project and the
review store of each owned one; both are user-driven events, not a timer.

## Not done here

- A cross-canvas view of NOTES (not reviews) — the mock's own reasoning (a note
  count means two things at once) still holds.
- Anything beyond the approved mock (an overview page, tabs) — not asked for.
