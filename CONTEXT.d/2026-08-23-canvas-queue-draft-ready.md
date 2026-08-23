# 2026-08-23 — #364 + #366: draft/ready rounds and the review queue (owner pick B)

One piece of work, as the mock proposed and the owner picked (canvas review
`R1: "B"` on the queue-states mock; drafts-invisible confirmed again in chat:
"I don't want to be told about it or see it until the agent has done their
review").

## The round's life

Drafting → Review needed → With the agent → Verdict owed → Closed.

- **Drafts (#366).** `canvas_render` gained `ready`. `ready: false` is a
  DRAFT: it supersedes the previous draft IN PLACE (one version id per loop,
  so self-review cannot burn the 500-version cap), the change event carries
  `draft: true`, and the renderer surfaces nothing — no pulse, no count, the
  pane keeps showing the last ready version (the display version skips
  drafts; the version picker never offers one; a canvas with only drafts says
  "the agent is preparing a draft" instead of posing as empty). `ready: true`
  promotes the draft and stamps `awaitingReview` on the canvas record.
  **Absent = the legacy contract**: surfaces immediately AND counts as ready,
  so an old-style agent's hand-off is never invisible. The flag is
  shape-checked at the MCP ingress (a string "false" is refused, not
  truthy-surfaced).
- **A submit clears the owed round**: `submitReview` calls the canvas store's
  `clearAwaitingReview` after its own commit (the review store already
  imports the canvas store, so the dependency points the existing way). A
  submit while the agent is drafting freezes against the version the user
  SAW — the last ready one — never the draft (`SessionCanvas` grew
  draft/ready id lists for exactly this).

## The one number (#364)

queue = canvases with `awaitingReview` + `verdictRounds` (submitted reviews
with zero open notes and ≥1 addressed — computed in
`getReviewCountsForCanvas` from the same per-review tallies the close-out
gate uses, so the label and the mutation cannot disagree). `listAll` rows
carry `awaitingReview`/`awaitingReviewAt` (from the canvas record, so a
hand-over never hides behind an unreadable reviews.json) and `verdictRounds`
(sweep-bounded, undefined-when-unreadable like the other counts).

One derivation feeds every surface: `totalsFromEntries` folds the queue +
`queueRows`; `useCanvasQueue` mixes the sweep with the live mirrors for the
on-screen canvas (fresher in both directions — the old pill's rule kept).

## Pick B, shipped

- The Canvas button stops being furniture while anything is owed: warning
  colour, the label says **Review needed**, the count rides in the same
  colour. The **purple pulse is retired** (one signal, one meaning); the
  from-TWO rule went with it — a queue shows from one.
- Clicking the count opens the queue popover: one row per owed round
  (Review/Verdict badge, title, age), click = that canvas via the picker's
  reclaim path + the pane opens. Unreadable canvases are named, never
  presented as clear.
- The session TAB carries a small warning dot + "waiting on you" while its
  queue is non-empty (`TabCanvasQueueMark`, hydrates the sweep lazily so
  background sessions count too).
- Picker and library rows: owed rows sort above recency and carry the badge;
  quiet rows carry nothing.

## Also in this branch (owner asks, same session)

- **Plan pages pin x-ray to Stealth** and drop the Off/Stealth/On switch —
  the boxes-on-page x-ray adds nothing over a document of steps ("remove the
  xray from planning mode… should just always be stealth").
- The agent-facing skill text (canvas-plugin) teaches the draft → self-check
  → ready loop and that `ready: true` ends the turn.

## Traps hit

- `var(--color-peach)` is the RETIRED palette spelling — the new
  badges/popover use `var(--accent-tip)` (the semantic peach), which the
  palette scan enforces the moment a file classifies as a dialog/menu.
- The old button tests pinned the pulse and the from-two pill; they were
  REWRITTEN to the new contract, not deleted — the no-dot assertion now pins
  the retirement itself.

## Adversarial rounds 2–3 (independent Opus): the hand-over is deferred at the STORE

Round 1's renderer-only silence was wrong twice over (mirror pinned while
main's session binding had moved: user notes resolved a canvas they had
never seen; one pane toggle lost the deferred filing notice). Root fix: a
subject-change DRAFT no longer repoints `sessionIndex` or files anything —
an in-memory `draftIndex` records where the agent drafts, `canvas_snapshot`
follows it (new snapshot-only `getAgentCanvasState` dep), and the
ready-mark performs the repoint + filing in one event, which is what the
renderer announces against. Deliberate residual trades: a draft-only canvas
IS still listed in the picker/library (hiding it would make an abandoned
one undeletable — the row is quiet and lands on the honest draft banner),
and `versionCount` stays the TOTAL because it labels Delete, which destroys
drafts too; recency and the mode chip stay drafts-excluded. Final verdict:
PASS (3 rounds).
