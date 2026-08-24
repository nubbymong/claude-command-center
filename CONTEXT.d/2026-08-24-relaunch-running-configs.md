# 2026-08-24 — configs relaunch while running; count pill replaces the lock

Owner revision (rc.1 install pass): "I got the design of sessions wrong — a
running session SHOULD be allowed to be launched again; show how many are
running but still allow another to be spawned. Quick Start too." This
supersedes the locked-row half of the two-mode panel design from earlier the
same day.

- `runningConfigCounts(sessions)` (savedConfigsView) is the new source: live
  sessions per config id, ask sessions excluded. `runningConfigIds` remains,
  derived, for set-shaped callers.
- **ConfigRow**: the locked branch is DELETED. A running config is a normal
  row — Launch and Edit live — plus a green count pill (`● N`,
  `config-row-running-count`) whose click jumps to the LATEST live session.
  Only Delete is refused while sessions run (`canDeleteConfig`,
  `DELETE_WHILE_RUNNING_REASON`): removing the template under live sessions
  would strand the Running rows. Drag-to-reorder no longer cares about
  running.
- **ConfigContextMenu**: Edit ENABLED while running (a template edit shapes
  future launches — the point of relaunch), with the hint "Edits apply to
  sessions launched from now on"; Delete stays refused with the shared
  reason. The pin hint reads "Quick Start can spawn another" (it used to
  promise deferral).
- **QuickStartPanel**: every pinned config shows, running or not, with the
  count pill on live ones; Start always spawns another instance. The
  "N running" header hint is gone (nothing is hidden any more).
- **Launch-all (group/section)** still fills in only what is NOT running —
  bring-up semantics kept deliberately: doubling a whole group silently is
  never what "launch all" meant; a duplicate is the single row's deliberate
  act.
- Tests rewritten to pin the revision (relaunch fires, pill counts and jumps,
  delete refused with reason, Quick Start keeps running pins, launch-all
  bring-up), plus `runningConfigCounts` counting.
