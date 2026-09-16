## 2026-09-16 -- 2.1.1 prep: the largest files split into focused modules

Branch `refactor/pty-manager-simplify` off `beta` (`bdec34ac`, `2.1.0-rc.17`).
The decision and the rules it produced are ADR-021; this is the run log.

### What moved

| file | before | after |
| --- | --- | --- |
| `src/main/pty-manager.ts` | 5,711 | 5,116 |
| `src/main/index.ts` | 1,353 | 980 |
| `src/preload/index.ts` | 1,496 | 1,337 |
| `src/renderer/App.tsx` | 1,669 | 1,445 |
| `src/renderer/components/Sidebar.tsx` | 1,733 | 1,708 |

Ten new modules: `ssh-sentinel-parsers`, `tmux-archive-cache`, `ssh-line-buffer`,
`codex-spawn-identity`, `splash-window`, `app-menu`, `ipc/cli-handlers`,
`ipc/clipboard-handlers` (main); `utils/closeSessionBatch`,
`utils/injectAttentionStyles` (renderer). `withProfileHome` joined
`account-profiles.ts`, the geometry helpers joined `window-state.ts`, the
logs-wipe pair joined `ipc/logs2-handlers.ts`, `restoreSavedSessions` joined
`session-persistence.ts`, and 48 hand-written preload subscriptions became one
`onChannel` helper (51 `ipcRenderer.on` sites at beta, 3 kept as-is on purpose).
The dead machine-name boot gate went: nothing ever set `showMachineNamePrompt`
to true.

Not touched, on purpose: the SSH state machine closure in `spawnPtyResolved`
(the #242 boundary) and the Sidebar tab panels (a split would only move the
complexity into a twenty-prop contract).

### Review evidence

Three adversarial passes (ADR-009) on the first cut: pty-manager (3 lenses,
PASS), preload `onChannel` (2 lenses, PASS), the `index.ts` handler relocation
plus the splash `webPreferences` (2 lenses, FINDINGS). The two majors there
were both introduced by the relocation itself -- the logs-wipe pair had drifted
from right after `registerResumeHandlers()` to after `initLogging`, and the
once-per-process shape test could not see a delegated `register*Handlers()`
call in `createWindow()`. Fixed in `4916ba79`, each fix mutation-verified.

Re-attack on `4916ba79` (2 Opus attackers, Fable orchestrating), plus the
double review (spec compliance on main, spec compliance on preload + renderer,
each an independent Opus reviewer):

- Adversarial: 0 blockers, 2 majors, 4 minors -- all test strength, none a
  code regression. The restored logs-wipe slot was pinned by a comment only
  (moving it back stayed green across 2,797 tests); `app.on('activate')` had no
  test looking at it; the once-flag ordering check was a two-name whitelist; the
  splash guard was first-match; no converted preload site had a test. Every
  one now has a shape or unit test, and each new test was checked red against
  the mutant it exists to catch.
- Spec compliance: COMPLIANT on both halves, 0 majors. Every extraction diffs
  clean against its origin as code. The one systematic minor: about 150 lines
  of rationale comments had not travelled with the code (splash, clipboard,
  CLI probes, menu, display clamp, the tmux "never rejects" contract, the whole
  `restoreSavedSessions` history). Restored verbatim. Also: a dead `app` import
  in `pty-manager.ts`, a stale gate list and a dropped provenance note in
  `boot-gates.test.ts`, and commit messages whose counts were off by a few
  lines (the table above is measured, not quoted).
- Both `injectAttentionStyles` originals differed: TabBar's copy lacked the
  `insights-pulse` rules. Sidebar mounts first and both shared the element id,
  so the superset always won; the dedupe removes a latent order dependence
  rather than changing behaviour.

### Live SSH statusline matrix (path-triggered gate, AGENTS.md)

Ran against the real hosts: 185 key PASS, Pi password PASS, Rocky password
PASS, mac key PASS, T20 docker rootless PASS. T21 (docker rootful), T24 and
T25 (zsh fixture) failed on `sudo` provisioning because the first run carried
the wrong sudo credential for the Rocky host; the re-run is owed and was
blocked on 2026-09-16 by the Rocky guest being down (owner's call to start
it). T7 (Windows remote) is the known upstream `claude` gap, not a failure.
Every extracted module is on the path of the four passing core lanes.

### Next

PR 2 (`build/2.1.1-prep`): merge `main`'s `2.1.0` version bump back to beta,
vitest 4.1.11 (not 5: #613's 5.0.0 is a test-semantics migration), Electron
43.7.1 (not 44: #594's CI shows the clipboard API break and the ABI gap, kept
for 2.2), node-pty beta.15, zod, marked, `@types/better-sqlite3`, the nine
CodeQL dismissals through an adversarial pass, the 2.1.1 changelog entry.
Owner desktop-tests beta before any release is cut.
