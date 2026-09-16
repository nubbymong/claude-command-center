# ADR-021: Split the largest source files into focused modules, as pure moves

- Status: Accepted
- Date: 2026-09-16

## Context

Five files had grown past what a reviewer, or an agent with a bounded context,
can hold at once: `src/main/pty-manager.ts` (5,711 lines), `src/renderer/
components/Sidebar.tsx` (1,733), `src/renderer/App.tsx` (1,669),
`src/preload/index.ts` (1,496) and `src/main/index.ts` (1,353). Three of them
sit on the ADR-009 security-sensitive path table (PTY argv construction, the
preload bridge, the IPC registration order in the boot sequence), so
"simplify" is not free: a move that reorders a registration or drops a guard is
a security regression that reads as a refactor.

The first cut of this work proved the point twice. Folding the logs-wipe
handlers into `registerLogs2Handlers` moved them from directly after
`registerResumeHandlers()` to after `initLogging`, behind twenty unguarded
`register*()` calls, and the whole suite stayed green. Delegating CLI and
clipboard registration to `register*Handlers()` functions made a duplicate call
from the macOS dock-reopen path invisible to the once-per-process shape test,
and the whole suite stayed green. Both were found by the adversarial pass, not
by CI.

## Decision

1. **Extract by cohesion, as pure moves.** Each new module is the code that
   left the old file, unchanged, plus the imports and exports the move needs:

   | from | to |
   | --- | --- |
   | `pty-manager.ts` | `ssh-sentinel-parsers.ts`, `tmux-archive-cache.ts`, `ssh-line-buffer.ts`, `codex-spawn-identity.ts`; `withProfileHome` into `account-profiles.ts` |
   | `main/index.ts` | `splash-window.ts`, `app-menu.ts`, geometry into `window-state.ts`, `ipc/cli-handlers.ts`, `ipc/clipboard-handlers.ts`, the logs-wipe pair into `ipc/logs2-handlers.ts` |
   | `preload/index.ts` | one `onChannel` helper replacing 48 identical subscribe/dispose blocks |
   | `App.tsx` | `restoreSavedSessions` into `session-persistence.ts`; the dead machine-name boot gate deleted |
   | `Sidebar.tsx`, `TabBar.tsx` | `utils/closeSessionBatch.ts`, `utils/injectAttentionStyles.ts` |

2. **Two things are deliberately not extracted.** The SSH state machine inside
   `spawnPtyResolved` (about 2,600 lines) stays one closure: the closure scope is
   the #242 boundary, a sentinel parser that can only see its own session's
   line buffer cannot be handed another session's. The Sidebar tab panels stay
   in `Sidebar.tsx`: at twenty-plus props each, splitting them moves the
   complexity into a prop contract instead of removing it.

3. **Rules every future extraction follows.** Each one is a finding this pass
   produced and fixed:

   - A pure move carries its comments. The first cut dropped about 160 lines of
     rationale (the splash CSP reasoning, the clipboard retry, the tmux "resolves
     null, never rejects" contract, the #397 crash-window note in the restore
     path). Code that lost its "why" is the most expensive kind of simplification.
   - Process-global registrations (`ipcMain.handle` / `ipcMain.on`) live inside
     the once-guarded `registerMainWindowIpc()` or in the boot sequence. Never
     in `createWindow()`, never in `app.on('activate')`. The shape test rejects
     any `register*Handlers` reference in either, not only a call.
   - A boot-order-sensitive registration keeps its slot and gets a shape test
     that pins the slot. A comment is not a guard.
   - New `src/main/ipc/*` modules use `IPC.*` constants, never bare channel
     literals, so a misspelling fails typecheck instead of silently orphaning a
     renderer feature.
   - Test seams (`_setTmuxArchiveResolverForTest` and friends) are re-exported
     from the original module, so the tests keep their import paths and a
     behaviour change cannot hide behind test-import churn.
   - A `let` binding that crosses a module boundary (`splashShownAt`,
     `tmuxArchiveResolver`) is read live at the use site. Snapshotting it into a
     const at import time is a regression, and the bundle was checked to keep
     the live binding.
   - A moved function does not gain a value import from a module that imports
     this one back. `restoreSavedSessions` needed two liveness helpers whose
     store imports `persistSessionState` from `session-persistence.ts`; the
     caller injects them, and the signature uses type-only imports for `typeof`.

4. **Evidence required before merge.** An adversarial pass per boundary touched
   (ADR-009), a spec-compliance review that diffs every moved body against its
   origin, a code-quality review, and the live SSH statusline matrix for the
   `pty-manager.ts` extraction (AGENTS.md, path-triggered gate).

## Consequences

- `pty-manager.ts` 5,711 to 5,115, `main/index.ts` 1,353 to 979,
  `preload/index.ts` 1,496 to 1,337, `App.tsx` 1,669 to 1,445, `Sidebar.tsx`
  1,733 to 1,708. Ten new modules, each small enough to review whole.
- `splash-window.ts` is evaluated early in `main/index.ts`'s import list, so
  `splashShownAt`'s initial value is taken a few milliseconds earlier than the
  old module-body `let`. Only the splash-skip paths (e2e, missing page) can
  observe it, and the effect is a slightly shorter pre-reveal hold.
- The old files stay facades for the re-exported test seams. That is
  intentional: the seams are the test contract, the module layout is not.
- No user-facing change. No changelog entry beyond the 2.1.1 line that names
  the refactor.

## References

- ADR-009 (adversarial review gate), ADR-012 (session isolation).
- #242 (the SSH sentinel boundary), #371 (`window-state.ts` origin), #384
  (splash build identity via URL query).
- `CONTEXT.d/2026-09-16-2-1-1-module-split-refactor.md` for the run log.
