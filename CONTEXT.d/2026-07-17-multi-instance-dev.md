## 2026-07-17 -- Multi-instance: DEV alongside PROD (branch feat/multi-instance-dev)

Goal: run the installed PROD build continuously while opening a DEV build (npm
run dev / ccc) beside it, with the dev window clearly labeled. See
architecture/decisions ADR for multi-instance for the full rationale.

Already in place before this work (split by app.isPackaged):
- Single-instance lock: dev skips it, prod takes it -> they already coexist.
- MCP port dev 19433 / prod 19333; vision CDP dev 9322 / prod 9222; update-server
  9847 + vite 5173 are dev-only.

Gaps closed:
- DATA ISOLATION (the master switch): everything (resources/CONFIG,
  session-state.json, transcripts.db, app.log, profiles, credentials) derives
  from getDataDirectory(). Added a CCC_DEV_DATA_DIR override in data-paths.ts
  (mirrors CCC_E2E_DATA_DIR), checked before the registry, treated as configured
  (skips the wizard). index.ts sets it early when !app.isPackaged (before any
  data-dir read / worker fork) to <LOCALAPPDATA>\Claude Command Center\dev. Prod
  is completely unaffected.
- HOOKS PORT split: resolveHooksPort(isPackaged) -> dev 19434 / prod 19334 (the
  last unsplit port).
- DEV labeling: OS title "Claude Command Center -- DEV" (guards
  page-title-updated); app:isDev IPC + preload appIsDev + useIsDev() hook;
  TitleBar amber DEV pill + amber underline accent.

Non-goals: two prod instances (blocked by design); two dev instances (the ccc
launcher refuses a 2nd via a port-5173 guard rather than an app-side lock, to
avoid Electron's single-lock/userData entanglement with prod).

Caveat: CCC's own state is isolated, but the underlying Claude CLI global home
(~/.claude) is still shared -- don't run the SAME account's Claude session in
both instances simultaneously.
