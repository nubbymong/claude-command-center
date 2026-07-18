## 2026-07-17 -- ccc dev launcher (repo-distributed) + docs protocol adoption

ccc launcher:
- Moved the `ccc` dev launcher INTO the repo (scripts/ccc.cmd) so its
  isolation/seed/cleanup logic is versioned; the PATH entry
  (%APPDATA%\npm\ccc.cmd) is now a thin shim that forwards to it.
- Behavior: sets CCC_DEV_DATA_DIR; auto-closes the window on exit; on exit KILLS
  the whole dev process set so nothing leaks -- headless vision Chrome (matched
  by its --user-data-dir=...chrome-debug-9322 marker), dev port holders (5173,
  9847, 19433, 9322, 19434), and dev electron (matched by the hyphenated repo
  path so a prod install never matches).
- Flags: --seed (copy PROD CONFIG into the dev data dir first; reads
  ResourcesDirectory from HKCU\Software\Claude Command Center, falls back to the
  default), --clean (wipe the dev data dir first), -nv/--no-vision. `--seed`
  still launches the app afterward (it is a pre-launch step, not seed-only).

Docs protocol (this branch, docs/handbook-and-carp):
- The repo had README + CONTRIBUTING but NO running decision log and NO ADRs.
  Adopted the CARP convention: CONTEXT.d/ fragments are the sole tracked source;
  CONTEXT.md is a generated aggregate and is gitignored (/CONTEXT.md).
- Added architecture/decisions/ ADRs for the two architectural calls
  (multi-instance dev/prod isolation; session work-name model), a
  docs/agent-conventions.md, a docs/dev-alongside-prod.md guide, and a
  docs/USER_GUIDE.md end-user manual. NOTE: root AGENTS.md is gitignored here
  (".gitignore # Personal/local config"), so agent conventions live in
  docs/agent-conventions.md instead of a tracked root AGENTS.md.

Branch/landing state at time of writing: nothing merged to beta yet -- 3 fix PRs
(#118/#121/#122) + feat/session-rename + feat/multi-instance-dev + this docs
branch are all pending, blocked on owner review of the fixes.
