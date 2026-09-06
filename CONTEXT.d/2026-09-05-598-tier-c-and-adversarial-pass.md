## 2026-09-05 -- rc.15 on PR #598: Tier C (account usage + config-edit guard) lands, and the ADR-009 pass over the whole PR

**Placement correction.** The rc14 stability-review fragment placed Tier C (F4 + F5,
one per-profile consumer coordinator; F10, destination identity) on 2.2 tickets. The
owner then approved the rc.15 plan ("Account usage & config-edit safety", canvas plan
v2) that folds that work into PR #598 for rc.15, and it shipped there in three phases,
each double-reviewed (spec + quality) and mutation-checked before the next began.
That fragment's "Tier C ... is 2.2 work" line is superseded by this entry.

**P1 -- correctness, no UI (aicc_planning#48 #49 #54).** Every profile consumer now
registers for its life: headless runs (`claude-headless.ts`, the profile recovered
from HOME by `profile-id.ts`), Insights, cloud agents, and profile-pinned shell-only
sessions (`pty-manager.ts`), each with a per-ref leak bound. The delete guard, the
usage refresh and `isProfileInUseByLiveSession` all respect them. A token refresh
publishes its in-flight promise (`noteProfileRefreshInFlight`) and every consumer
waits it out (`waitForProfileRefresh`) so a CLI never reads a credential file
mid-rotation and redeems a spent single-use token later. Detached remotes record
port + runtime; ONE predicate (`src/shared/detached-destination.ts`) decides whether
a saved config still reaches where a session was left, applied in the renderer
(`matchDetachedRemotes`, the resume surface's retargeted Remove-only row) and in main
(`ssh:checkDetachedLive`, `ssh:endRemote` refuse a moved destination).

**P2 -- usage logic.** An OPEN account (one a live session uses) is served from the
figure its own statusline delivered (`setStatuslineUsageSink` ->
`recordLiveUsageForSession`, fresh under 90 s) with NO network call; only CLOSED
accounts call, staggered. The agreed Q1b exception: credits the statusline cannot
carry cost ONE GET with the live token, never a rotation. The primary is excluded.

**P3 -- UX.** The usage page streams (`accountUsage:fetchAllStream`, a renderer-named
private reply channel delivered only to the caller's own webContents): a skeleton
row per account fills as each result lands, with a terminal row on failure or a
superseded stream. A config-edit guard (`configEditGuard.ts`,
`ConfigEditGuardDialog.tsx`) warns -- never blocks -- before editing an SSH config
with a live or left-running session; every edit entry point in the Sidebar routes
through one chokepoint (`requestEditConfig`).

**Adversarial pass (ADR-009) over the WHOLE PR, one bounded round.** Phase 0.5 wrote
down 61 theses and found 10 unasserted and 4 weak. Four independent attackers
(bypass + credentials on opus; injection + platform parity, blast radius, coverage by
mutation on sonnet) returned 0 blockers, 4 code majors, several minors, and 13
coverage gaps. What changed, each with a regression test that goes red when the fix
is reverted:

- SSH container flow: the saved sudo secret was auto-typed on any sudo-shaped prompt
  while the post-command was out -- including one printed INSIDE an already-entered
  container (the idle fallback promotes with the secret unsent). Now gated to the
  pre-inner-shell window, the shape the SSH-password gate (F13) already had.
- tmux liveness: BEGIN was the FIRST match in the buffer while END was the last, so a
  login banner could forge FOUND + a session name ahead of the real probe and revive a
  dead session in the resume list. BEGIN is now the last one before the chosen END.
- `profileIdFromHome` compared the profiles-root segment case-sensitively; a home
  handed back as `Account-Profiles\<id>` (or an 8.3 short name) silently skipped the
  consumer registration and the rotation wait. Compared as the filesystem would now.
- Close coordinator: a quit held on a renderer that then crashed was held forever.
  `render-process-gone` now releases it, and a repeated quit overrides a held one,
  the rule the window's close event already applied to a second Alt+F4.
- Consumers acquired the hold AFTER waiting out an in-flight refresh, leaving a
  microtask in which a fresh rotation could start. All four acquire first.
- The usage stream had no per-caller cap and a destroyed sender only stopped the
  sends: N reopenings were N parallel fan-outs against an IP-rate-limited endpoint.
  One stream per sender now; a newer one, or a gone sender, stops the loop.
- The delete guard is re-checked after the awaited web-session clear, so it covers
  the whole delete and not only its first instant.
- The rotation backup snapshotted on the first poll after a credential change; a
  /login writes the credential and identity files separately, and a snapshot between
  the two mixed one account's identity with another's token. It now snapshots only
  once the credential stamp is unchanged on the poll after it moved, which gives the
  identity write a whole poll to land before the email guard judges it. The identity
  file is deliberately not part of the stamp (the quality review caught the first
  version keying on it): the CLI rewrites `.claude.json` on ordinary turns, and
  waiting for it to go quiet would have starved the backup for as long as the user
  was working.
- An empty or non-string host never agrees as a detached destination; the #54 guard's
  threat model (a stale or edited config, not a hostile renderer) is stated where the
  guard lives.

Coverage: all thirteen guarantees the pass found unasserted now have a test that goes
red when the guard is removed -- the preload's private per-call channel (real preload,
electron mocked); the credential stamp's shape on a real profile dir and the handler's
validate-before-read; the delete guard through the real handler; the shell-only hold
after a throwing spawn; stat-only rotation following; the Q1b path with a LAPSED
token; the statusline sink and the window-created reset in index.ts, by shape; the
endRemote refusal preceding the keychain read; both browser spawn sites shell-free by
shape; and every Sidebar edit entry point on a mounted Sidebar. Three control
mutations on already-asserted theses went red as expected.

**Re-attack (fresh attacker against the patched code): PASS, 0 blockers, 0 majors.**
Every fix held against its original attack and every regression test went red under
its mutation. Its minors, closed in the same round: a junctioned `account-profiles`
root (target named otherwise) had started reading as "not a profile" -- the text and
the on-disk name are now EITHER/OR; `render-process-gone` with reason `clean-exit`
(a reload, not a death) no longer waives the close dialog; `closeWindow` guards a
destroyed window; a duplicate `window:allowClose` closes and quits once; a delete
refused after the awaited web-session clear now drops the cleared session's record
and says so. Spec review: PASS. Quality review: one major (the identity-file stamp
above), fixed; its nits (timer-ordering and shape-regex comments) addressed.

**Not changed, on purpose.** A detached row written before #54 (no recorded port)
still matches any port on the same host/user/path -- the upgrade-without-orphans
trade-off in `detached-destination.ts`. A container that echoes the captured host
prompt reads as a failed entry and Run again re-writes the exec into the inner shell
(bounded: same container, needs a click). Anchored popovers and context menus do not
register with the pane-occlusion store (by design, see the #44 fragment). A
frozen-but-alive renderer still needs a second Cmd+Q: an automatic timeout would quit
under a user reading the dialog. Windows 8.3 short names resolve only when the parent
exists on disk. The pass surfaced no pre-existing vulnerability needing an advisory.

**Surface sweep to do before the cut.** A known-issues entry for the Q1b credits gap
(an open paid-credits account never network-fetched this run whose current tick has
extra-usage OFF shows no credits row until the session closes or the next extra-usage
tick; self-heals). A user-facing note that closing a container-session tab ends the
remote session with no dialog (F12). Tips for the usage-page reuse and the config-edit
guard.
