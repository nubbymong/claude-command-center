## 2026-08-29 -- Agent Canvas rework (2.1.0-rc.10): the whole review model, in one branch

The canvas rework agreed with the owner on 08-28/29 landed as one branch on
`beta`, targeted at `2.1.0-rc.10` on the 2.1 line (not 2.2, despite the design
memo's filename). Five milestones, built in order, each gated before the next.

**The model, in three sentences.** An artefact (a mockup, a plan, or a build
under test) accrues versions, and exactly one of them is ever open for your
decision: you approve or reject THAT version, and notes you send with an
approval are recorded as observations rather than work, so approving owes the
agent nothing. When nothing else on the canvas is still open, an approval signs
the artefact off by itself into the project Library; when something is, the
panel says what, and `Mark complete` closes it by hand after naming exactly
what it will force closed. Settled stays settled -- render, resolve, supersede,
reload and agent-chat verdicts can never re-wake a closed round, and only the
user's own Reopen can.

## What shipped, by milestone

- **M1 -- settled state machine.** Version-level decisions only (per-note
  verdicts are gone; the agent's A/B/C alternatives are read-only labels and
  the pick is named in chat). Approve owes nothing; notes filed with it become
  `observation`. One active round per artefact. Settled-stays-settled with
  stored provenance (`Review.settled.by`), surfaced as plain phrases
  ("approved with observations", "closed by the agent on your instruction").
  `Mark complete` is never a dead control: hidden while the displayed version
  is still the user's to decide, enabled otherwise, and auto-complete fires on
  a USER approval only (never reachable from MCP).
- **M2 -- review panel v3.** History folded at the top of the panel, a plain
  `OPEN` pill on the live round instead of a count that argued with the queue,
  a decision bar whose submit names the decision ("Submit -- Approve v3, 2
  notes"), and a waiting state after submit instead of a dead compose box.
  On-disk composer drafts per canvas (decision, text, target, images, sketch,
  pending capture), restored only onto the same artefact run. Multi-image paste
  with inline `Image N` markers that renumber on removal. Drawings ride the
  next note automatically (the attach button is gone). Sketch is a real toggle
  with a `Tools` companion. Tall-page scroll fix, ~150ms pane crossfade, one
  DismissButton where there had been two.
- **M3 -- Testing mode.** Starting a note pauses the served build behind an
  input shield and locks evidence together: screenshot (with the drawing laid
  over it), a state stamp (route, dialogs, focus, per-field
  empty/filled/changed/invalid) and the timed action trail since the last note.
  Structure never content: not one character of a typed value is stored, by the
  shape of the code rather than by a filter. Notes collect into a Pass/Fail
  pack (name derived, renamable); after the verdict the pane serves read-only
  recall and never the live site again. `canvas_review` hands the agent the
  structure by default and screenshots only on `includeShots`.
- **M4 -- ownership lease, front page v8, Library v2, Canvas Explained.** The
  lease is liveness, not a stored flag: an in-flight canvas is private to its
  live session, becomes ownerless when that session goes, and is taken over by
  an atomic first-wins `Resume` (the loser is told, never silently ignored).
  `Dismiss` discards it and names what goes. Read-only viewers get memorialised
  work only, with all eight mutating affordances suppressed. Front page v8:
  artwork + wordmark, IN FLIGHT WORK band (owed card, approved-plan jump,
  resume card), typed recents in three columns. Library v2: search, kind tabs,
  state chips, a per-row audit line, expandable evidence packs, bulk bar.
  Canvas Explained as a front-page card and a live Feature Guide embed. A quiet
  mauve resume dot on the canvas button, deliberately not folded into the
  amber queue count.
- **M5 -- the release surface sweep (this commit).** `changelog.ts` gains a
  `2.1.0-rc.10` entry (13 items) and `CHANGELOG.md` is regenerated;
  `app-knowledge.ts` corrects what approving actually owes and adds
  settled-stays-settled; `tips-library.ts` updates the four stale canvas tips,
  adds three (testing evidence, resume/dismiss, Canvas Explained) and deletes
  `tip.excalidraw-scratchpad`; the guided tour gains its first canvas step
  (anchored on a new `data-tour="canvas-button"`); the README's canvas section
  is rewritten to the new model.

## Owner flags

- **The sketchpad lost its front-page entry.** The v8 rewrite dropped "Open the
  sketchpad instead" and nothing replaced it: the `sketchpad` store value is
  still reachable programmatically and still renders (with a floating way out),
  but there is no door in from anywhere -- front page, Library or button menu.
  Restoring a user-facing entry is an owner decision, so the removal is NOT
  claimed in the changelog. Two consequences are already live:
  `tip.excalidraw-scratchpad` was deleted this sweep because it told users to
  click something that is gone, and `src/renderer/training-steps.ts` (the
  Feature Guide card) still documents the route "Session toolbar -> Canvas ->
  Open the sketchpad instead", which is now stale and was left alone as out of
  this sweep's scope.
- **Read-only pack recall shows Library evidence, not full recall.** A test
  pack belonging to another session cannot be recalled note-by-note; the pane
  says so and points at the Library row's expandable evidence. The seam is
  deliberate (notes stay with their session) and self-documenting at the point
  of need, so no known-issues entry was added -- recorded here as a gap, not a
  bug.
- **The rc-prerelease tour/What's-New nuance.** On the beta channel every
  prerelease opens What's New with the complete content (rc.6), so the rc.10
  entry is seen in full by testers; the guided tour, by contrast, is
  onboarding-only, and its new canvas step is anchored in a session's command
  bar, so a first run with no session yet skips it by design. An existing user
  meets the canvas step only by replaying the tour with a session open.
- **The README canvas screenshot is stale.** `docs/screenshots/shot-canvas.png`
  predates the pane redesign, testing mode and front page v8. The prose was
  updated; the image was deliberately NOT touched or removed, because the owner
  reviews every image. It needs an owner-reviewed reshoot before 2.1 promotes.
