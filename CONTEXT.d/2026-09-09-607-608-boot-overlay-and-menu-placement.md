# 2026-09-09 — #607/#608: two overlays that ignored the screen

Both found by the owner install-testing a local build of #606
(`2.1.0-rc.16-pr606`, head `694d618a`), and both fixed on that same PR: it is the
current RC cycle's only PR, and #605 is what made each of them reachable.

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
  prefer the pointer, flip above/left on overflow, clamp to the margin, and cap to
  the roomier side so a menu taller than the window scrolls instead of
  overflowing. Repositioning and capping are BOTH needed — repositioning alone
  still loses items on a short window, a cap alone strands a click near the bottom
  with a sliver of room.
- Measured in `useLayoutEffect` (before paint, so no visible jump), from
  `scrollHeight` not `offsetHeight` — measuring the box after a cap is applied
  shrinks it a little further on every pass — and the state update is skipped when
  nothing moved, which is what stops the measure -> setState -> measure loop.
  `accountOpen` is a dep because expanding the account list changes the height.

Scoped to `SessionContextMenu`. Seven other menus share the `fixed` + raw-`x`/`y`
pattern (`ConfigContextMenu`, `GroupContextMenu`, `DockRowMenu`,
`MultiSpawnPopover`, `RemoteResumableSection`, `TabBar`, `CloudAgentsPage`); the
helper is general so they can adopt it, but widening the change onto a PR that had
already passed its reviews is follow-up work, not this fix.

## Verification

`tests/unit/renderer/menu-placement.test.ts` (11 cases: fits below, flips up,
caps and scrolls when it fits neither side, roomier-side selection both ways, the
minimum cap, both horizontal overflow directions, the far corner).
`account-launch-gate-lastused.test.tsx` gains the suppression cases, including the
one that matters most — **suppression must not resolve or consume the queued
request**. Both fixes are one JSX expression each, which no behavioural test can
see, so `boot-overlay-wiring.test.ts` asserts the wiring against the source, the
technique `app-lifecycle-wiring.test.ts` established. Each fix was mutated and
confirmed to turn a test red.
