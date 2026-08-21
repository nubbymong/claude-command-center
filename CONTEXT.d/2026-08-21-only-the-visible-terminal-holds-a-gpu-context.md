# 2026-08-21 — Only the visible terminal holds a GPU context

Backlog item 36, the half #333 did not reach. #333 fixed the *damage* (the clears
were what blanked the other terminals). This removes the *condition* that made
the damage possible, and with it the second blocker that kept GPU rendering
opt-in.

## Two limits, one cause

Every session keeps its `TerminalView` mounted — that is what makes tab switching
instant and what keeps scrollback alive — and each mounted terminal held its own
WebGL context for as long as it existed. That runs into two limits that look
unrelated and are not:

1. **Chromium allows roughly sixteen WebGL contexts per renderer** and evicts the
   oldest beyond that. So a seventeenth session did not merely fail to get a
   context: it took one from a terminal that was using it, and eviction arrives
   as a context-loss event — i.e. as the storm `installWebglWithRecovery` exists
   to survive. The recovery code was being asked to absorb a self-inflicted
   problem.
2. **`@xterm/addon-webgl` keeps one glyph atlas per PROCESS.** Every extra live
   context is one more terminal that someone else's `clearTextureAtlas()` can
   blank. That is the whole of the beta.15 corruption
   ([[terminal-webgl-atlas-root-cause]]).

Both reduce to "more than one live context". A terminal that is not on screen
renders nothing, so it was paying both for no benefit at all.

## The change

WebGL is attached in its own effect keyed on `isActive`, and detached in that
effect's cleanup. `isActive` is already exactly "this pane is on screen": App
renders every session but sets `display:none` on all but the active one, the
partner pane replaces the main one, and a page tab in front makes it false for
every terminal. So at most one context exists at a time, and often zero.

`WebglHandle` gained `dispose()`. It has to stop the recovery machinery as well
as drop the addon — otherwise a recreate already queued for the next frame
resurrects the context after the caller believed it gone, which is precisely the
race a user creates by switching tabs during a GPU blip.

The atlas-coordinator registration moved into the same effect. A terminal with no
context has nothing to resync, and leaving it registered had it clearing its
render model on behalf of an atlas it was not drawing from.

The cost is a re-raster when you come back to a tab — but that tab has to repaint
on becoming visible regardless, so the work overlaps with a repaint that was
already going to happen.

## What is now testable, and what still is not

`installWebglWithRecovery` is pure enough to test properly: detach disposes and
repaints, is idempotent, refuses to re-acquire on a later context loss, and
refuses on a recreate that was *already queued* when the pane went away. That
last one needed a deferred rAF rather than the synchronous stub the other tests
use — with a synchronous stub the ordering is unreachable, and one of the two
detach guards was consequently untestable (it went green under mutation until the
deferred case existed).

The placement rule — install happens in a visibility-keyed effect and NOT in the
mount effect — cannot be observed from jsdom, because mounting `TerminalView`
means building an xterm terminal, a WebGL addon and a `ResizeObserver`. So
`webgl-visible-only.test.ts` reads the source: one call site, inside an effect
whose deps include `isActive`, with a cleanup that disposes, and after the mount
effect stopped doing it. Mutation-checked in both directions.

**No test here proves anything about a GPU.** The VM's only adapter is Hyper-V
Video, which Chromium blocklists, so `new WebglAddon()` throws there and a clean
run is a false pass. Whether the attach/detach is visually seamless on real
hardware — no flash on tab switch, no perceptible re-raster — is a question only
the owner's machine can answer, and it is the question that gates flipping the
default.

## Items 37, 38 and 39

- **37 (report upstream)** not done: it means opening a public issue on the
  xterm.js repository, which is an outward-facing act on someone else's project.
  Worth doing — a process-global atlas any terminal can wipe with no notification
  to the others is arguably their bug — but it is the owner's call.
- **38 (measure whether WebGL earns its place)** is now the meaningful next step,
  and it needs the hardware this change cannot be tested on.
- **39 (`staleGlyphRepaint.ts`)** deliberately left alone. Its condition was "if
  WebGL goes", and WebGL is staying. It is worth revisiting *after* 38: with a
  single context its premise — an atlas emptied by another terminal — can no
  longer occur, and a full atlas rebuild on scroll is expensive.
