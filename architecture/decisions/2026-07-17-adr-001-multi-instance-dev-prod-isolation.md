# ADR-001: Multi-instance dev-alongside-prod isolation

- **Status:** Accepted (2026-07-17)
- **Deciders:** @nubbymong (owner)
- **Related:** CONTEXT.d/2026-07-17-multi-instance-dev.md, docs/dev-alongside-prod.md

## Context

Developers need to run the installed **production** build continuously (as their
daily driver) while opening a **development** build (`npm run dev` / `ccc`)
beside it to test changes. Before this decision the two builds could technically
both launch (dev already skipped the single-instance lock), but they shared
mutable state and one port, so running them together was unsafe:

- **Shared data dir.** `getDataDirectory()` resolved to the same location for
  both. Everything hangs off it — `resources/CONFIG` (configs + `session-
  state.json`), `transcripts.db`, `debug/app.log`, account profiles, credentials.
  Concurrent read/write would corrupt config and session state.
- **One shared port.** The hooks gateway defaulted to `19334` for both. MCP
  (19433/19333) and vision CDP (9322/9222) were already split by `app.isPackaged`;
  hooks was not, so a second instance hit `EADDRINUSE`.
- **No visual distinction.** Two identical windows are easy to confuse — a
  destructive action in the wrong one is a real risk.

## Decision

Activate a **dev profile** whenever `app.isPackaged === false`. Production
behavior is unchanged (every branch below is a no-op when packaged).

1. **Data isolation via a single switch.** Add a `CCC_DEV_DATA_DIR` override in
   `data-paths.ts`, checked *before* the registry and treated as "configured"
   (skips the setup wizard) — mirroring the existing `CCC_E2E_DATA_DIR`. Because
   `resources/CONFIG`, `transcripts.db`, `app.log`, profiles, and credentials all
   derive from `getDataDirectory()`, this one override isolates all of them. The
   main process sets it early (before any data-dir read or worker fork; workers
   inherit the env) to `<LOCALAPPDATA>\Claude Command Center\dev`. The `ccc`
   launcher also sets it, so a bare `npm run dev` is isolated too.
2. **Split the last shared port.** `resolveHooksPort(isPackaged)` → dev `19434` /
   prod `19334`, matching the MCP/CDP pattern. A per-config `settings.hooksPort`
   still overrides.
3. **Label the dev window.** OS title `Claude Command Center — DEV` (guarding
   `page-title-updated` so the renderer can't overwrite it); an `app:isDev` IPC
   surfaced to the renderer (`useIsDev()`), driving an amber `DEV` pill + accent
   in the title bar.
4. **Keep the single-instance model.** Prod keeps its lock; dev keeps skipping
   it (so it coexists with prod). A *second dev* is refused by the `ccc` launcher
   (a port-5173 check), NOT by an app-side lock.

## Consequences

- One prod + one dev run safely in parallel, on fully separate data and ports.
- First isolated dev launch starts empty; `ccc --seed` copies prod's `CONFIG`,
  `ccc --clean` wipes the dev dir. (See docs/dev-alongside-prod.md.)
- **Rejected: an app-side dev single-instance lock.** Electron's lock is keyed on
  the app identity/`userData`; making dev request it would entangle it with
  prod's lock (or require moving `userData`, which relocates Electron's cache/
  cookies). The launcher-side port guard is simpler and prod-safe.
- **Known limitation:** CCC's own state is isolated, but the underlying Claude
  CLI global home (`~/.claude`) is shared. Running the *same account's* Claude
  session in both instances at once can contend on OAuth token rotation. Documented,
  not fixed here.
- Cost: a small amount of dev-only branching (`!app.isPackaged`) across
  `data-paths`, `index`, `hooks-types`, and the title bar. All unit-tested
  (`resolveHooksPort`, the `CCC_DEV_DATA_DIR` override + E2E precedence).
