## 2026-08-22 -- #385 model picker: effort-reset fix + versioned-id e2e (PR #404)

Two deliverables on `fix/385-versioned-model-picker`, both green.

### Finding #1 fix -- effortLevel not reset on model change (SessionDialog)

In `src/renderer/components/SessionDialog.tsx` the "Starting effort" chips grey
out (`disabled`) for a level the selected model does not support, but the stored
`effortLevel` state was never cleared when `model` changed. Repro: default model
-> pick `xhigh`/`ultracode` -> switch to `claude-opus-4-6` (which disallows
them). The chip greyed but the value still submitted, launching
`--effort xhigh --model claude-opus-4-6`. The footer popover never had this hole
(disabled rows are unclickable); only the dialog did.

Fix: a `handleModelChange(nextModel)` wraps `setModel` and, when the current
effort is non-empty and no longer supported by the new model, resets it to `''`
(Default, always valid). Support is computed via the SAME `effortsForModel(reg,
model)` the chips use to gate `disabled` -- no second source of truth. The model
`<select>`'s `onChange` now calls it. Minimal, event-driven (no `useEffect`).

Tests: added three cases to `tests/unit/renderer/session-dialog-effort.test.tsx`
(clears the chip on an unsupported switch; `onConfirm` cannot carry the
unsupported `--effort`; a still-supported effort survives -- no over-reset).
`claude-opus-4-6`'s registry effort list is `[low,medium,high,max]`, so it is
the natural "disallows xhigh/ultracode" fixture. Whole file: 9/9 pass.
Typecheck clean.

### Deliverable 2 -- versioned model-picker e2e (desktop-gate evidence)

Added `tests/e2e/model-picker.spec.ts` (pattern from
`session-dialog-permutations.spec.ts` + `helpers/electron-app.ts`). In the real
packaged app: New-config -> Claude x Local -> the "Starting model" `<select>`
offers a PINNED versioned row `Opus 4.6` -> `claude-opus-4-6` under its family
`<optgroup>` and it is selectable (proves #385's versioned ids appear). Then the
chosen id round-trips UNCHANGED into the persisted config read back from
`resources/CONFIG/configs.json` in the isolated data dir. Screenshot attached by
PATH (the `list` reporter drops body attachments).

Teardown trap re-confirmed: creating a Claude config launches it, leaving a live
PTY as an Electron child; on Windows `app.close()/kill()` does not reap the
subtree and the orphan hangs Playwright's worker teardown. `afterAll`
tree-kills with `taskkill /pid <electron> /T /F` (stdio ignored) before
`closeIsolatedApp`. With that: `1 passed`, clean exit.

Build note: `npm run build` MUST precede Playwright (a stale `out/` lets the
setup modal intercept clicks); `npm run test:e2e` does not build. Worktree
natives (node-pty, better-sqlite3) ship win32-x64 prebuilds, so the
allow-scripts skip did not block launch.
