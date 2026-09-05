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

**Review round 2 (Tier A).** Spec + quality reviews found: the close coordinator is a
process singleton, so a Save-close left `allowClose` set and a dock-reopened window was
never asked (BLOCKER -> `onWindowCreated()` from `createWindow`); F11 only did half the
ticket -- every candidate is now existence-gated and prints a FOUND marker, and END
without FOUND parses as unverified (never death); the rotation stamp was per session
(N sessions -> N backups) -> per profile; the re-auth pending path skipped the attempt
backstop; an end-to-end F6 test now drives the real backup/restore over a temp root.

**Tier B (live-host findings), same PR.**
- F13 `pty-manager.ts`: the SSH-password branch is open only while the flow is still
  `connecting` -- once the first shell prompt (or the idle fallback) has carried the
  flow past login, a password prompt is sudo's: the sudo branch answers a post-command's
  sudo with the saved sudo secret, and a sudo the user ran by hand is left to them.
  Auth-stage prompts (including a bare `Password:` before login completes) still get
  the SSH secret. Accepted edge: a host that pauses longer than the idle window between
  its pre-auth banner and its password prompt has already left `connecting`, and that
  password is typed by hand (app-knowledge known issue).
- F1 `pty-manager.ts`: three signals on the line-buffered, ANSI-stripped post-command
  output of a container session, watched only from the moment the command was actually
  written (`postCommandWritten`; the 200ms defer used to let a host prompt repaint be
  read as the inner shell -- the prompt-path transition now requires it too):
  `CONTAINER_ENTRY_ERROR_RE` (engine, socket, podman and sudo failure shapes:
  definitive); the host shell's own prompt line coming back (`hostPromptLine`, the last
  prompt-shaped line seen before the click: definitive, and what catches Ctrl-C at the
  sudo prompt or any message the regex does not list); the shell's engine-not-found line
  (`CONTAINER_ENGINE_NOT_FOUND_RE`: a suspicion, since an rc file inside a healthy
  container can print it -- the prompt that follows decides, and the idle fallback fails
  a suspect entry that never showed a prompt, which is how a zsh host is covered). A hit
  sets `runtimeEntryFailed`, fails the flow (`container entry failed`), gates both
  inner-shell transitions and makes `launchClaude()` re-emit the failure instead of
  walking the host ladder. The idle fallback in `running-postcommand` now holds
  (bounded) instead of promoting while nothing beyond the command's echo has come back
  (a hung engine or a still-starting container; the cap fails the entry) or while a
  password prompt is on screen (a human typing a sudo password; the cap advances as
  before). `runPostCommand()` accepts the failed-entry state as the one re-entry: it
  resets the entry watch and the sudo latch and writes the post-command again; the
  overlay's failed card offers Run again for that reason (Retry Launch would only
  re-emit). Skip stays the explicit route to the raw host shell. Positive controls: a
  real inner prompt, a slow start, an unrecognised (starship) inner prompt and an rc-file
  not-found line all still reach `awaiting-claude / inner`. The runtime line buffer is
  cleared on both success transitions and in `clearAllSshLineBuffers`.
- F12 `sshCloseStore.ts`: a container session's close calls `ssh.endRemote` (session +
  config id) before the local kill, no dialog; legacy docker post-command sessions
  count; plain and persistent SSH sessions unchanged. The gate is
  `isContainerRuntime(effectiveSshRuntime(cfg))`, the runtime main actually uses -- not
  `isContainerSsh`, which also accepts the badge-only `dockerContainer` hint and would
  spawn an end exec for a session that never took the container hop.
- Both pty-manager changes sit in the SSH-flow blast radius: the live SSH matrix + a
  Docker host run are recorded in the PR before merge (the "connectivity suite").

**Review round 2 (Tier B).** Spec + quality reviews of the first Tier B round found two
MAJORs: F1 only recognised engine error text, so a sudo refusal, Ctrl-C at the sudo
prompt, a socket permission error, podman's stopped-container message or plain silence
still promoted the host prompt to inner; F13 gated on `postCommandSent`, which left the
common no-post-command session typing the SSH secret into a hand-run sudo. Both fixed
as above, plus the minors: the runtime buffer's teardown and success clears; the regex
narrowed (standalone `is not running` dropped, the shell not-found shapes moved to the
suspect regex); the changelog's "keeps refusing until the container is fixed" replaced
by an actual in-session Run again; F12's gate tightened. Every new test was
mutation-checked (ten mutations, each caught). Recognising failure shapes plus the
host prompt's identity is the ticket's own fix shape: a narrowing of the review's
"positive evidence from inside the runtime", which would need the composed entry
command to carry a marker and cannot cover a hand-written post-command.

**Deferred / not changed.** The review's INCIDENT assessment needs no code; the
`existsSync` vs `isFile` hardening from the earlier adversarial pass is still deferred.
Tier C (F4 + F5 consumer coordinator, F10 destination identity) is 2.2 work, tickets
aicc_planning#48, #49, #54.
