## 2026-09-05 -- RC14 stability review: fourteen findings verified, eleven fixed on the rc.15 PR

**Source.** An owner-commissioned, agent-written review pack of rc.14 (commit a2af4d98):
three P1 and eleven P2 findings with runnable reproductions (five vitest files, a
callback harness that executes source extracted by AST). The owner's instruction: the
author was not an expert, so every finding must be verified first.

**Verification.** All ten reproduction tests and all five harness mechanisms reproduced
against the current beta (unchanged since the review), and each cited site was read.
Every finding held; where the review hedged (F12: the in-container process is not
measured to survive; INCIDENT: the login-refresh warning's cause is unproven) the hedge
was right. Tickets aicc_planning#45-#58 (one per finding, premise sections, `bug` +
workstream labels) carry the detail; PR #598 carries the fixes.

**Placement.** Tier A (no live host needed) on PR #598: F2, F3, F6, F7, F8, F9, F11, F14.
Tier B (live hosts) on the same PR once verified: F1 (container entry -> host launch),
F13 (SSH password typed into a bare sudo prompt), F12 (container tab close skips the
in-container kill). Tier C as 2.2 tickets: F4 + F5 (one per-profile consumer coordinator:
register headless / Insights / cloud-agent / login-shell consumers, and make new consumers
wait out an in-flight refresh), F10 (detached entries keyed on the full destination).

**What each Tier A fix does.**
- F8 `pty-manager.ts`: the exit handler already skipped cleanup for a replaced process
  but still sent the id-only `pty:exit`; the stale branch now returns before it. Test
  restarts under one id with a fan-out `onExit` mock -- pty-manager registers two
  listeners on the replaced process, and a last-wins mock had made the test pass against
  the bug (caught by the mutation check; the file is CRLF, which had also defeated the
  first mutation attempt).
- F14 `session-persistence.ts`: `loggingEnabled` now round-trips in `claudeOptions`.
- F11 `ssh-liveness.ts`: `TMUX_LIVENESS_BIN_EXPRS` mirrors the End command's candidate
  list (PATH, both Homebrew prefixes, system, staged); a parity test pins the two.
- F6 `claude-account-identity.ts`: the identity poll stats the profile's
  `.credentials.json`; a change after the first observation re-snapshots canonical
  (`backupProfileHomeToCanonical` stays email-guarded, so a switched account never lands).
- F7: new read-only IPC `accountProfiles:credentialStamp` (stat stamp + signed-in, no
  token contents); `useReauthAccount` completes only when the stamp changed and the
  account reads signed in. Older preloads keep the email-only rule. IPC addition ->
  adversarial pass with the Tier B work.
- F9 `session-persistence.ts` + `App.tsx`: `persistDetachedOnlyOrClear` writes an empty
  session set that keeps the registry (zero-tab close, Don't open, Don't save);
  `hydrateDetachedFromSavedState` hydrates it at boot without a restore and after a
  decline, then the reachability pass runs.
- F2 + F3 `index.ts` + new `window-close-coordinator.ts`: one state machine for "may the
  app go away" shared by the window `close` event and `before-quit`; a quit with a live,
  not-yet-allowed window is held and asks the renderer, then re-issued once allowed, so
  the teardown (now `quitTeardown`) runs on that pass, once. The 207-line block of
  process-global `ipcMain` registrations moved verbatim (line-based script, anchors
  asserted) into `registerMainWindowIpc()` behind a once-flag; the close-dialog state
  left the `createWindow` closure. The review's lifecycle harness no longer parses the
  refactored handler by shape; the coordinator's unit tests drive both doors through
  Electron's event order instead, and a static test pins the source shape. Owner
  verifies on a real Mac before merge.

**Deferred / not changed.** The review's INCIDENT assessment needs no code; the
`existsSync` vs `isFile` hardening from the earlier adversarial pass is still deferred.
