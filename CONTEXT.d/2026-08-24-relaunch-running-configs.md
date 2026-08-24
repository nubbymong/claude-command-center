# 2026-08-24 — configs relaunch while running; count pill replaces the lock

Owner revision (rc.1 install pass): "I got the design of sessions wrong — a
running session SHOULD be allowed to be launched again; show how many are
running but still allow another to be spawned. Quick Start too." This
supersedes the locked-row half of the two-mode panel design from earlier the
same day.

- `runningConfigCounts(sessions)` (savedConfigsView) is the new source: live
  sessions per config id, ask sessions excluded. (`runningConfigIds` was
  deleted in the review round — nothing consumed set semantics.)
- **ConfigRow**: the locked branch is DELETED. A running config is a normal
  row — Launch and Edit live — plus a green count pill (`● N`,
  `config-row-running-count`) whose click jumps to the LATEST live session.
  Only Delete is refused while sessions run (inline guards at both surfaces
  sharing `DELETE_WHILE_RUNNING_REASON`): removing the template under live
  sessions would strand the Running rows. Drag-to-reorder no longer cares
  about running. Review round: the hover action strip parks LEFT of the pill
  (right-12) so it cannot swallow the pill's clicks, and the pill carries an
  aria-label.
- **ConfigContextMenu**: Edit ENABLED while running, with the hint "Edits
  apply to sessions launched from now on" — and SessionDialog shows an amber
  note when the edited config has live sessions, naming the two restart
  hazards (an SSH restart after a connection edit is REFUSED by
  spawn-credential binding; a restarted shell whose command line changed runs
  WITHOUT its secret argument); Delete stays refused with the shared
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
