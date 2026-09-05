## 2026-09-05 -- Native panes hide under page tabs, dialogs and the tour (artifacts-over-Settings)

**Report (owner, rc.14).** Open claude.ai artifacts in the in-app browser pane, then open
Settings: the artifacts view sits in front of Settings. A z-order fix had landed before
(the freeze / Excalidraw bleed-through, rc.1 era); this is the next instance of the same
class, so the class is what got fixed.

**Mechanism.** The browser pane and the claude.ai account pane are WebContentsViews:
main paints them above every pixel of HTML, so CSS stacking cannot put anything over them.
The renderer hides a view (main detaches it) when its session stops being the active
session -- `WebviewPane`'s `isActive` prop, `session.id === activeSessionId` in App.tsx --
and while the freeze modal is up. Opening a page tab (Settings, Tokenomics, Logs, Feature
Guide, ...) does not change the active SESSION, only `view`, so the view stayed attached and
painted over the page. The partner terminal and the canvas already gate on
`view === 'sessions'`; the browser pane did not. Dialogs and the tour had the same gap.

**Fix -- one answer to "may a native pane paint".** `src/renderer/stores/paneOcclusionStore.ts`
holds the active tab (`activeView`, published by App.tsx from `view` in a LAYOUT effect, so
the store is current before the new tab paints) and a count of
mounted window-level overlays (`acquireOverlay` / `useOccludesNativePanes`). A pane is
occluded when the active tab is not `sessions` or any overlay is held. `WebviewPane` folds
that into `shown = isActive && !occluded` and uses `shown` everywhere `isActive` used to
drive the native view: the two visibility effects, the two bounds effects (so a re-measure
runs on un-occlusion, the same reason `frozenImage` is in those deps), AND the ref that
parks `tryOpen` / `tryOpenAccount` -- so a view requested while Settings is on top is not
created-then-hidden (main attaches on create; an open resolving after the hide would have
left it in front) but parked until the pane may show; and a hide that arrives while the
open round trip is in flight is re-sent once main has registered the view (a hide before
that was a no-op there -- `setWebviewVisible` / `setAccountPaneVisible` early-return on a
missing entry). Registered overlays: the shared `DialogOverlay` when `position === 'fixed'`
(every dialog built on the E5 primitives at once); the six modals that still hand-roll a
`fixed inset-0` scrim (`CommandDialog`, `NoteDialog`, `HideDockFeatureDialog`,
`GuiExeDialog`, `CapturedRunModal`, the command bar's `ConfirmCard`); `GuidedTour`; and
`TrainingWalkthrough` only while it covers the session area (first-run, or help mode
expanded to the centred panel -- the collapsed help card is a corner card over an app that
stays interactive and must not blank the pane for its whole life). `SetupDialog`
early-returns instead of the shell; onboarding renders beside a shell whose pane is closed
by default and never restored at boot, so no pane exists under either.

**Deliberately not registered.** Anchored popovers (command-bar menus, context menus,
tips): non-modal, no scrim, and their being painted over by the pane rectangle when they
overlap it is a pre-existing limitation the favourites bar was designed around (a row, not a
menu). A popover flashing the pane away would be worse than the overlap.

**Tests.** `tests/unit/stores/paneOcclusionStore.test.ts` (every page kind occludes;
overlays nest and release once); `tests/unit/renderer/webview-pane-occlusion.test.tsx`
(ordinary view and account view: hide under Settings, come back, park an open under a page
tab, session-level flag still rules); `tests/unit/renderer/dialog-primitives.test.tsx`
(a fixed DialogOverlay holds the flag for its mounted life, an absolute one does not).

**Tracking.** aicc_planning#44 (bug, 2.1 line, rc.15). Ships in the same PR as the
aicc_planning#43 fix: one PR for the rc.14-feedback fixes, per owner.
