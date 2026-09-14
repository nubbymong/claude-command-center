# ADR-002: Session work-name (rename) model

- **Status:** Accepted (2026-07-17)
- **Deciders:** @nubbymong (owner)
- **Related:** CONTEXT.d/2026-07-17-session-rename.md

## Context

Users run many sessions at once and need to name each one for the work it's
doing ("IM-8315 keychain fix"), tracked through restarts until the session is
closed. Two problems with the state before this decision:

1. **No editable session name existed** beyond the config-derived `label` shown
   on the tab.
2. The sidebar's existing "Rename" wrote **both** the session `label` **and** the
   underlying Saved Config's `label` (`updateSession` + `updateConfig`). So
   renaming a session silently renamed the *config template* it launched from —
   the confusing behavior users hit.

## Decision

Introduce a per-session **`customName`**, distinct from `label`, as the work name.

- **Decoupled from the config.** Rename writes `customName` ONLY; it never
  touches the Saved Config. Config rename stays a separate action in Saved
  Configs. `label` remains the config-derived origin (shown as secondary /
  tooltip).
- **Display = `customName || label`** everywhere a session is named (tab, sidebar
  row, session header). Blank clears `customName` (reverts to `label`).
- **Display-only.** It is CCC metadata; it does not rename the Claude transcript,
  the `~/.claude` project, or the OS window.
- **Lifecycle = the session's `id`.** Persisted in `session-state.json` by id, so
  it survives app restart and returns when a saved session reopens; it is gone
  once the session is closed in CCC (which is the whole point — it tracks *open*
  work).
- **Edit surfaces:** sidebar right-click Rename, tab double-click / right-click,
  a click-to-edit field in the session header, and **F2**. F2 targets the
  **Active Sessions** row in the sidebar (only while the sidebar is visible),
  preferred over the tab.
- **Logs durability (deliberate extra).** Renaming persists the name into
  `transcripts.db` (`run-rename` worker message → `renameRun` UPDATE on the
  latest run; `LOGS2_RENAME_SESSION` IPC), and spawn-time `configLabel` uses
  `customName || label`. So the logs/history tab keeps the name **even after the
  session is closed**. Chosen over a renderer-only join (which would only cover
  live sessions) because the owner wanted the name to survive in history.

## Consequences

- Renaming a session no longer mutates its config — the reported confusion is
  gone, and configs stay stable templates.
- One choke point: `store.renameSession` writes `customName` and fires the logs
  IPC; every edit surface routes through it.
- The standalone `RepoBreadcrumb` strip (cwd + repo/connection) was folded into
  the session header at the same time, collapsing two bars into one below the
  tabs (see CONTEXT.d fragment).
- Cost: a DB write path across the transcripts worker/IPC/preload, plus a new
  persisted field on `Session`/`SavedSession`. Unit-tested (store rename set/
  clear, persistence round-trip, `renameRun` targets the latest run, logs IPC
  fires with the effective name).
