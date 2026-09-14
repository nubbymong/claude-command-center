## 2026-07-29 -- Settings > Check for Updates can install the update (#142)

Bug: `CheckForUpdatesField` (SettingsPage.tsx) reached `status === 'available'` and
rendered only a TEXT label ("Update available -- vX"). No action — the user had to
know to find the small green Update pill in the bottom bar to actually install.

- The primary button now BECOMES "Install now" when a check finds an update
  (the Check/Install states swap; "Check now" returns otherwise), plus a small
  "Restarts CCC; open sessions are saved." hint.
- IMPORTANT correctness point: the button must NOT call `update.installAndRestart()`
  directly. App's `onUpdateRequested` installs immediately only when there are ZERO
  sessions; with sessions open it opens the `closeDialog === 'update'` flow so
  session state is saved and pending config writes flushed BEFORE the restart. A
  direct call would restart on top of live, unsaved sessions.
- Therefore extracted App's previously-inline BottomBar `onUpdateRequested` arrow
  into a named `handleUpdateRequested` and passed it to BOTH `BottomBar` and
  `SettingsPage`; `SettingsPage` forwards it to the field. Direct `installAndRestart`
  remains only as a no-prop fallback (mirrors BottomBar's existing pattern).
- Renderer-only; no IPC/main changes (`update:installAndRestart` already existed).
- `CheckForUpdatesField` is now exported so it can be unit-tested.
- Tests: tests/unit/renderer/settings-check-for-updates.test.tsx — initial state,
  Check->Install swap + version shown, up-to-date path, Install routes to
  onUpdateRequested and NOT installAndRestart, no-prop fallback, repeat-click guard.
  6/6; full renderer suite 749/749; web typecheck clean.

Changelog: deliberately NOT added here. v2.1.0-beta.2 is already published, and the
beta.2 changelog entry lives on the still-open bump PR (#141) — so this note belongs
in the NEXT version's entry rather than being folded into a released one.
