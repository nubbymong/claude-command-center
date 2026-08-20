## 2026-08-20 -- Agent Canvas: naming the dimensions problem, and the first two answers

Owner's ask (twice): a counter on the canvas icon when more than one review is in
flight, and a way to switch between canvases. Their framing: "there are a lot of
dimensions -- versions of the same thing, multiple items for review etc."

### The dimensions, as they actually are

| Level | Cardinality | Visible before this |
| --- | --- | --- |
| Canvas (one SUBJECT) | up to 50 per session, exactly 1 active | NO -- the pane never named it |
| Version | up to 500 per canvas, append-only | yes, a picker (hidden at one version) |
| Review | up to 200 per canvas; 1 draft, any number submitted | barely -- a `Review #N` tag on each note |
| Note | up to 100 per review | yes, but FLATTENED across reviews |

The gap that hurts most is at the top. `CanvasState.title` was stored in main and
crossed the IPC boundary from the start; the renderer's mirror copied three
fields and dropped it, so the pane could say which VERSION you were on but never
which canvas -- and had nowhere to put "and there are three others".

### Shipped now (the two that needed no decision)

1. **The pane leads with the subject.** `title` added to `CanvasSessionState` and
   copied in `fromMain`; the header renders it in place of the static "Agent
   Canvas", falling back to that for a canvas rendered before titles existed.
2. **Open-review count**, in two places. New derivation `openReviewsOf` =
   `status === 'submitted'`. That is not an approximation of "open": a review only
   becomes `'resolved'` when no member note is still `open` or `addressed`, and
   the agent's own write never recomputes status, so a count from it cannot
   disagree with the data.
   - Pane header: from ONE ("2 reviews open") -- you are already looking at it.
   - Canvas button: from TWO, as a pill BESIDE the label. Two reasons for both
     choices. The threshold, because a review closes only when every note has a
     verdict, so a permanent "1" stops meaning anything. The placement, because
     the corner already carries the unseen-render pulse, and one badge holding
     two meanings is worse than none.
   - The button hydrates the review mirror itself. It was only ever filled when
     the notes panel mounted, so a button badge would have read zero for any
     session whose pane had not been opened this run. Hydrating on the button
     costs one call per session you visit rather than one per session you hold.

**Deliberately NOT a note count.** `openSubmittedNotesOf` is the ready-made
derivation and the tempting one, but an `open` note waits on the AGENT and an
`addressed` note waits on the USER, and both are in that list. A number over them
means two things at once and neither party can clear it alone.

### Mocked up, waiting on the owner

`F:\CLAUDE_MULTI_APP_RESOURCES\canvas-dimensions-2026-08-20.html` (local review;
design material is not published). It proposes, with costs:

- **A subject picker** in the pane header -- a menu, NOT tabs: only one canvas can
  be mounted at a time (the snapshot registry is one frame per session) and a
  session may author fifty. Switching to a canvas this session ALREADY OWNS is a
  cheap index repoint that works even while another canvas is held -- that early
  return shipped with the library fix (`44c1923b`). What is missing is a way to
  ask "which of these are mine": `listAllCanvases` returns every canvas in the
  project and `CanvasLibraryEntry` carries no owner. One flag, threaded through.
  Adopting ANOTHER session's canvas stays in the Library, where the guards are.
- **A filing strip.** This is the real bug behind the complaint: a render naming a
  different subject files the current canvas and repoints the session, taking its
  unresolved notes out of view, and nothing says a word.
- **Notes grouped by review**, newest first, each with who it is waiting on, plus
  "Approve the remaining N" -- today a review can only close note by note.

Two owner calls the mockup asks for: whether the count spans canvases (needs a new
channel and a per-canvas sweep -- no main API enumerates reviews across canvases),
and whether a review can be closed in one action.

### Traps found while mapping (for whoever builds the rest)

- A broken `reviews.json` returns empty arrays, byte-identical to "no reviews" --
  a silent under-report in any count.
- Switching to a UAT canvas whose owner session's PTY has exited gives a dead
  frame: the served-root allowlist was revoked, so the version is unservable and
  the user gets the 8s timeout card. A switcher must mark or disable those.
- `deleteCanvas` from another window clears the index and emits a null active
  version; any switcher must survive its current entry disappearing.
- Review and annotation ids restart per canvas, so "Review #1" is ambiguous
  across canvases and nothing disambiguates it today.
- The active canvas is not persisted; after a restart it is GUESSED by recency.

### Still required before merge

ADR-009 pass over the whole PR batch. Nothing in this commit touches ownership,
adoption or the served-root allowlist -- the switcher would, and that is the
highest-risk edit in the feature.
