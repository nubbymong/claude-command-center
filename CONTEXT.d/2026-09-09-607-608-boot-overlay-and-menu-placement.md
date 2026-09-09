# 2026-09-09 — #607/#608/#609: three surfaces that ignored the chain

#607 and #608 were found by the owner install-testing a local build of #606
(`2.1.0-rc.16-pr606`, head `694d618a`); #609 fell out of the adversarial pass on
their fix. All three land on that same PR: it is the current RC cycle's only PR,
and #605 is what made the first two reachable.

They are one bug three times over. `pickBootGate` exists because first-launch
surfaces used to stack, and its own doc says exactly one may render at a time —
but three surfaces were still deciding for themselves. Two painted over a gate;
the third vetoed one and stranded the boot.

## #607 — the account picker painted over the Multi Spawn startup page

`AccountLaunchGate` was rendered unconditionally at app root while every
first-launch surface goes through `pickBootGate`. A restore spawns its sessions
as soon as the `resume` gate is answered, and each eligible session raises an
account picker on its first spawn — so those pickers landed on top of the Multi
Spawn startup page, which sits deliberately LAST in the chain (*after* `resume`,
because its per-row copy counts are read from the sessions the restore brought
back).

It is the third boot-time overlay found outside the chain. `bootGates.ts` already
records the other two — Sentinel and the resume prompt, both folded in on
2026-08-21 — and the doc comment claims that list is complete. It was not.

- Suppressed while any gate is up, the same treatment `SentinelPanel` gets, via a
  `suppressed` prop rather than a store read (the boot gate is local App state).
- **The queue is preserved, not drained.** The awaiting spawn holds a promise with
  no timeout anywhere on that path (`accountGateStore.requestChoice` ->
  `TerminalView`'s `.then`), so suppression parks it and the picker surfaces
  unanswered once the chain clears. Draining or defaulting it would launch
  sessions under an account the user never chose — the one outcome worse than the
  bug.
- The `suppressed || !pending` return sits after every hook, so suppression never
  reorders hooks.

## #608 — the session context menu ran off the bottom of the window

`SessionContextMenu` is `position: fixed` at the raw pointer coordinates with no
clamp, no `max-height` and no `overflow`. Anything below the bottom edge was
unreachable: no scroll region in the menu, and `fixed` items cannot be scrolled to
by the page. Latent since the menu was written; what made it reachable was height
— Switch Account expands inline to one row per account, and #605 added a four-row
Watchdog block above it.

- New pure helper `utils/menuPlacement.ts` (`placeMenu` -> `{left, top, maxHeight}`):
  prefer the pointer, flip above/left on overflow, clamp to the margin, and cap so
  a menu taller than the window scrolls instead of overflowing. Repositioning and
  capping are BOTH needed — repositioning alone still loses items on a short
  window, a cap alone strands a click near the bottom with a sliver of room.
- Measured in `useLayoutEffect` (before paint, so no visible jump), from
  `scrollHeight` not `offsetHeight` — measuring the box after a cap is applied
  shrinks it a little further on every pass — and the state update is skipped when
  nothing moved, which is what stops the measure -> setState -> measure loop.

Scoped to `SessionContextMenu`. Seven other menus share the `fixed` + raw-`x`/`y`
pattern (`ConfigContextMenu`, `GroupContextMenu`, `DockRowMenu`,
`MultiSpawnPopover`, `RemoteResumableSection`, `TabBar`, `CloudAgentsPage`); the
helper is general so they can adopt it, but widening the change onto a PR that had
already passed its reviews is follow-up work, not this fix.

## ADR-009 pass on this delta

PASS on #607 — the property that mattered (a session must never spawn under an
account nobody chose, and must never be stranded) held under attack. Verified
independently: the gate store is mutated only by handlers bound to rendered DOM,
the component registers no global listeners and no effect cleanup, no boot gate
can strand a waiting spawn, and there is no timeout anywhere on that path.

One MINOR on #608, fixed here: **the dep list missed every PROP-driven height
change.** `accountOpen` is the only LOCAL state that resizes the menu; everything
else that adds rows arrives as a prop, `watchdogChecks` above all — pushed
asynchronously from main, so a menu right-clicked before its watcher reports is
measured short, takes the upward branch, and then grows a header, three toggles
and a hint BELOW a `top` that is never recomputed. The extra rows land off-screen
together with the scrollbar that would have reached them: this bug, re-entered
through the back door. A longer dep list would go stale again the next time this
menu grows, so it observes the element instead (`ResizeObserver`, guarded for
environments without one). Applying `maxHeight` changes the border box but not
`scrollHeight`, and an unchanged placement returns the previous object, so the
observer cannot drive a render loop.

Also from that pass, and caught by its own sweep test: the comfort floor could
still overflow a window shorter than itself. `placeMenu` was restructured so the
cap is DERIVED from the chosen `top` rather than computed beside it — it is now
always the room from `top` to the bottom margin, which makes
`top + maxHeight <= viewportHeight - margin` true by construction on every branch,
and a menu with too little room is LIFTED rather than capped to a sliver.

## #609 — a selected gate that rendered nothing

The pass also surfaced an adjacent, PRE-EXISTING deadlock, fixed here rather than
deferred: with `bootGate === 'resume'` and `tourActive` true, neither surface
rendered — the tour needed `bootGate === null`, the resume prompt needed
`!tourActive` — so `pendingRestore` could never be cleared, taking every gate
below it down with it. Reachable when the harness finishes with `startTour` on an
install that has saved sessions.

The cause is the one this module already warns about: a SPLIT decision. `resume`
kept the `!tourActive && !showGuidedConfig` conditions it needed back when it
rendered outside the chain, where they were the whole mechanism; folding it in on
2026-08-21 made them redundant at best and contradictory at worst. So the fix is
the module's own rule — one authority. `tourActive` and `showGuidedConfig` are
INPUTS now: `guidedTour` and `guidedConfig` are real turns, placed above the
`*Due` short-circuit because both are opened by a user action that has already
happened and must not be starved by a pending timer. The render sites test their
own gate name and nothing else.

The new-account prompt was the same class and is fixed with them: it excluded only
`'onboarding'`, so it could paint over the machine-name, consent, resume and Multi
Spawn gates. It owns no turn, so it is now suppressed by any gate, like Sentinel
and the account picker.

**The invariant, now tested:** a gate the chain returns MUST render. An exhaustive
sweep over every boolean combination of the thirteen inputs asserts the result is
always a real gate or null, and a source assertion pins that no render site
negates another gate's trigger — which is the shape the bug took.

## Verification

`tests/unit/renderer/menu-placement.test.ts` (14 cases: fits below, flips up, caps
and scrolls when it fits neither side, roomier-side selection both ways, the
comfort floor and its giving way on a short window, a negative pointer, both
horizontal overflow directions, the far corner, and a coarse sweep asserting the
box is on-screen and usable for every combination).
`account-launch-gate-lastused.test.tsx` gains the suppression cases, including the
one that matters most — **suppression must not resolve or consume the queued
request**. Both fixes are one JSX expression each, which no behavioural test can
see, so `boot-overlay-wiring.test.ts` asserts the wiring against the source, the
technique `app-lifecycle-wiring.test.ts` established. Each fix was mutated and
confirmed to turn a test red.

For #609: `boot-gates.test.ts` gains the tour/dialog ordering cases, the
starvation case, and the exhaustive sweep; `boot-overlay-wiring.test.ts` pins that
the resume site no longer carries `!tourActive`, that both new gates have render
sites, and that neither negated trigger appears anywhere in App. Deleting the
`guidedTour` line from the chain turns three of them red.
