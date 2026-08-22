## 2026-08-22 -- #209: e2e desktop-import spec (drive the desktop test)

Added `tests/e2e/desktop-import.spec.ts` so the desktop-chat import is exercised
in the REAL packaged app, not only in unit tests. Motivation: the desktop-test
merge gate (#309, `ci.yml` `desktop-gate`) is a human label because headless CI
can pass while the packaged app is broken -- but most of the import flow CAN be
driven, so an agent can do the legwork and produce evidence, leaving the human a
short eyeball + the `desktop-tested` label rather than the whole manual pass.

What it drives (Playwright `_electron`, isolated temp data dir via
`helpers/electron-app`):

- Creates a Claude x Local session (the import menu item is gated on
  `!shellOnly && sessionType === 'local' && provider === 'claude'`, Sidebar.tsx),
  right-clicks it, opens "Import Claude Desktop chat...".
- Paste leg: parse -> "Captured 2 messages / 1 code block" -> generate brief ->
  "Use this brief" -> asserts a `*.md` lands in `<workdir>/.claude/imports/`
  carrying the provenance banner -> "Send to session" closes the dialog.
- Share tab: renders its guidance and rejects a non-share URL (offline, no
  network). A real public fetch is env-gated behind `CCC_E2E_SHARE_URL` so CI
  stays deterministic.

Boundaries left to a human / unit tests, on purpose:

- "typed, NOT submitted" (no trailing CR) is the security invariant and stays
  unit-tested (`buildInjectPrompt`, `src/shared/desktop-import.ts`) -- xterm
  renders to a canvas with no DOM text to assert on.
- Org-scoped share needs a signed-in claude.ai account (#216); it cannot be
  scripted without credentials.

Traps hit while writing it (all fixed in the spec):

- The saved CONFIG and the running SESSION share the name, so a name-based click
  can open the wrong context menu. Target `.session-card` (unique to sessions;
  ConfigRow uses a different class) and open the menu with
  `dispatchEvent('contextmenu')` -- a synthetic right-click is refused because
  the row div overlays its own label span.
- The session leaves a long-lived shell PTY as a child of Electron; killing only
  the Electron pid orphans it and its inherited pipes hang Playwright's worker
  teardown. `afterAll` tree-kills the pid (`taskkill /T /F`, stdio ignored).
- The brief step tolerates either producer: CI has no `claude` (ENOENT -> fast
  deterministic extract); locally the headless `claude -p` pass runs and both
  prepend the same banner, so the assertion is mode-agnostic.

Green locally on beta.15 (2 passed, 1 skipped=share-fetch); `npm run typecheck`
clean. Requires a fresh `npm run build` first -- a stale `out/` desyncs the seed
and flakes every e2e. Does NOT clear the gate by itself (by design).
