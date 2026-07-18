## 2026-07-17 -- Session work-name (rename) decoupled from config (branch feat/session-rename)

New feature: rename an open session to track the work in each window. Persists
by session id across restarts; cleared when the session is closed in CCC.

Decisions:
- New `customName` field on Session/SavedSession, DISTINCT from the config-derived
  `label`. Display = `customName || label` everywhere (tab, sidebar row, header).
  Blank clears it (reverts to label). Display-only -- never renames the Claude
  transcript or the OS window.
- DECOUPLE from the Saved Config. The pre-existing sidebar rename did
  updateSession(label) + updateConfig(label), so renaming a session silently
  renamed its config -- the reported "confusing" behavior. Now the rename writes
  customName ONLY; config rename stays separate in Saved Configs.
- Edit surfaces: sidebar right-click Rename, tab double-click / right-click, a
  click-to-edit name field in SessionHeader, and F2. F2 was deliberately routed
  to the ACTIVE SESSIONS list in the sidebar (only when the sidebar is visible),
  preferred over the tab, per the owner's call.
- Header consolidation: folded the standalone RepoBreadcrumb strip (cwd + GitHub
  repo/connection) into SessionHeader, so there is ONE bar below the tabs instead
  of two. Deleted RepoBreadcrumb + its tests; SessionHeader test reproduces the
  path/repo coverage.
- Logs durability: renaming persists the name into transcripts.db (new run-rename
  worker message -> TranscriptsDb.renameRun UPDATE on the latest open run; new
  LOGS2_RENAME_SESSION IPC). store.renameSession is the single choke point (writes
  customName + fires the IPC). Spawn-time configLabel uses customName || label so
  a restored/pre-named session's log carries the name from its first run. Chosen
  over a renderer-only join because the owner wanted the name to survive in the
  history even after the session is closed.

Branch also merges the #120/#115 boot fix so a dev build boots fast; that merge
de-dupes once #121 lands on beta.
