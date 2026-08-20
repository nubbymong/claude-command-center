## 2026-08-20 -- Canvas: the switcher, removal, and telling the agent the truth

Owner approved the `canvas-dimensions-2026-08-20.html` mockup and added two
requirements: "give flexibility to remove as well" and "ensure the mcp/session is
informed in case there are manifests or whatever", plus "really think about how it
would work over time".

### The load-bearing decision: inform the agent through TOOL REPLIES, not chat

The obvious route was another `pty.write` line like the existing
`Review #3 - 5 notes . canvas_review R3` marker. It was rejected, and the reasons
are worth keeping because the idea will come back:

- **A canvas title is agent-authored free text.** `sanitizeCanvasTitle` is a
  DISPLAY sanitiser: it strips control/format/bidi and caps at 80 code points,
  and passes `.`, `#`, digits and the literal ASCII `canvas_review`. A canvas
  titled `Checkout . canvas_review R1` forges a second review marker in the
  app's own voice, straight into the agent's input, outside any envelope.
  Today's marker is 100% operator constants plus two regex-bounded integers.
- **`\r` submits.** The existing line is safe because the user just pressed
  Submit, so the TUI is idle by construction. A delete- or switch-driven line
  fires with nobody at the keyboard and concatenates with whatever is half-typed.
- **No live PTY means it is BUFFERED and replayed at the next spawn** — "the
  canvas you were rendering to was deleted", delivered hours later, to a fresh
  session, about a canvas that no longer exists.
- The 300ms identical-payload dedupe collapses two identically-worded events and
  lets two differently-worded ones through. It was built for command buttons.

So the agent is informed **at the moment it acts**, which is always a tool call:

- `canvas_render` now says when it FILED the user's canvas, when the user has
  unsubmitted notes (on this canvas or the one just filed), and which reviews are
  still open. At most TWO sentences per call -- this reply is the last thing read
  before the skill says to hand back in one line.
- `canvas_resolve` now says how many notes are still open and whether the user is
  still writing, so an agent cannot hand back "all addressed" over untouched work.
- Everything appended is counts and STORE-MINTED ids. Never a title, never a
  model-supplied path. Whole thing wrapped in try/catch: a throw escapes into the
  MCP SDK, which relays the raw message -- paths included -- unwrapped.

`renderVersion` now returns `filed?: { canvasId }`. `subjectChanged` was a local
boolean that never left the function, so nothing downstream could tell.

### The read that feeds it

New `getReviewCountsForCanvas(canvasId)` in the review store. Three deliberate
choices:

- **By canvasId, not session.** Every session-keyed read resolves through
  `sessionIndex`, which after a filing already points at the NEW canvas -- and the
  canvas most worth reporting on is the one just filed.
- **It must not write.** `loadRecord` re-stamps and PERSISTS a record whose
  embedded owner differs from the session asked for. A report that heals a file
  as a side effect of being read is not a report. Added a private no-rebind,
  no-cache reader sharing only the validator.
- **`null`, never zeroes,** for a broken or unreadable store. "Nothing
  outstanding" and "could not tell" must not look the same to an agent.

### The refusal now names the folders

Two field reports on the same day: one agent avoided the wrong folder only
because it had read the skill; another wrote its mockup to a scratch directory,
which the canvas will never serve, and the refusal ("not inside this session's
project folder") gave it nothing to correct -- and never mentioned the session
WORKTREE at all, though the skill does.

New `canvasRootsForSession(sessionId)` reads both registries; the refusals name
them. Safe to print: both paths are CCC's own (the configured project dir, and a
worktree location CCC computed), the agent's PTY is already inside the first with
the second in its env as `CCC_SESSION_WORKTREE`, and it is keyed on the
transport-bound id so it cannot widen. A folder NAME is still user-authored, so
it is stripped of control/format/bidi characters and capped before interpolation.

### Switching and removing

- `listAllCanvases` takes the asking session and returns `ownedByThisSession` /
  `isActiveForThisSession`. These are DIFFERENT questions: a session owns up to
  50 records and points at one. Both flags are **display only** -- delete is
  id-only with no ownership check at the IPC seam, so a "mine" badge must never
  be read as a permission. That is commented at every layer.
- Per-canvas open-review and draft-note counts are joined at the IPC handler,
  not in the store: the review store imports the canvas store, so the reverse
  would be a cycle (same reason the delete handler drops reviews there). The
  sweep is bounded -- own canvases always, then the first 20 of the rest -- so one
  library open is not a hundred synchronous reads.
- Ordering is BANDED (active, then mine, then the project's) and then newest-first
  inside each band, sorted on parsed time rather than lexical ISO strings, with a
  canvasId tie-break. Capped at 120 rows, sliced after the sort.
- The in-pane picker offers ONLY this session's own canvases. Switching between
  them is an index repoint that works even while another canvas is held (the
  early return that shipped with the library fix). Taking ANOTHER session's
  canvas is a real adoption and stays in the Library, where its guards are.
- **The library overlay was hoisted out of `CanvasSurface`.** Deleting the canvas
  you are looking at empties the pane, which unmounted the very overlay the
  delete button lived in -- a destructive control destroying its own host,
  mid-action.
- The delete confirm states what goes, and leads with unsubmitted notes: they are
  work the user never handed over and cannot recover.

### Filing, given a voice

The renderer can see a filing (the canvas id under the session changes) but had
nowhere to say so. `canvas:changed` now drives a `filedNotice` carrying the old
canvas's title and its note counts -- read from the review mirror BEFORE the
refresh follows the session to the new canvas, the only moment the renderer knows
what was left behind. A switch the USER asked for changes the same id, so the
picker sets a one-shot `expectSwitch` flag first; without it the strip would
announce the user's own click back at them (mutation-tested).

### Reviews as rounds

`reviewGroupsOf` groups submitted reviews newest-first with `waitingOn`:
'agent' while ANY note is still open, 'you' once every remaining note is
addressed, 'closed' when nothing is left. The draft review is excluded -- it is
the composer's own list below, and showing it twice is how the two get out of
step. Bulk "approve the remaining N" is offered ONLY when the round waits on the
user; while anything is open there is nothing to decide and the button would just
be a way to approve work nobody claims to have done. Dismiss is two-step.

### Also

`AGENTS.md` gained a section on using the canvas at all. Two sessions in one day
wrote a mockup to a file instead: the file is the artifact, the canvas is the
mechanism, and `.canvas-scratch/*.html` in the repo teaches the artifact. The
skill's "strictly turn-based" line was sharpened -- it was being read as "do not
poll for reviews" rather than "do not keep building past a handover".

### Still required before merge

ADR-009 pass. This touches the MCP tool boundary and its reply strings, the
served-root allowlist (via the new roots reader), the ownership plumbing in
`listAllCanvases`, and `renderVersion`'s return. Bound it: one round, scope =
`canvas-mcp-tool.ts`, `canvas/canvas-store.ts`, `canvas/canvas-review-store.ts`,
`ipc/canvas-handlers.ts`, `conductor-mcp-server.ts`. Two lenses worth naming:
(1) can a model-authored string (title, buildLabel, htmlPath) reach any
operator-voice line added here; (2) does the new by-canvasId reader ever write.

Pre-existing and untouched, worth flagging to that pass: `ipcMain.on('pty:write')`
validates nothing, and `formatTier1` wraps a body in bracketed paste without
stripping an embedded terminator.
