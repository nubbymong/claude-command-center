# 2026-08-04 — Training screenshots finally refreshed; capture runs against a throwaway data root

The training-walkthrough screenshots had been wrong for months. The previous session fixed
the four capture-script bugs that produced wrong *frames* (aria-label nav matching,
`__name` in evaluate bodies, the `setupVersion !== __APP_VERSION__` wizard gate, and the
unpackaged build's `CCC_DEV_DATA_DIR` override); this session fixed the reason the correct
frames still could not be *committed*: the run pointed the app at the user's real
resources/data directories, so Logs and Tokenomics rendered a real account address and
real spend figures, and these assets ship in a public repo.

## What changed (`scripts/capture-training-screenshots.ts`)

- `getResourcesDir()` / `getDataDir()` now resolve under `os.tmpdir()/ccc-capture-<pid>`,
  mirroring the `CCC_E2E_DATA_DIR` layout in `data-paths.ts` (data root = `<root>`,
  resources = `<root>/resources`) so the seed writes exactly where the launched app reads.
  The Windows-registry lookup is gone. The `~/.claude/projects` and `~/.codex/sessions`
  hide/restore steps stay — the app scans the real home dir regardless of data root. The
  root is removed after a clean run, left behind on failure for inspection.
- v2 stopped reading `tokenomics.json` (the v1 store): the dashboard queries
  `tokenomics.db`, built by a worker scanning `~/.claude/projects/**/*.jsonl`. The seed
  now writes six small demo transcripts (assistant lines with `usage`, cwd matching the
  demo configs' workingDirectory, registry model ids `claude-sonnet-4-6` /
  `claude-opus-4-8`) so the dashboard populates through the app's own scan + pricing
  pipeline. The json seed stays so a v1 build never scans real history.
- The session-options shot drove v1 dialog UI that no longer exists ("Shell only"
  checkbox, "Model override" select). It now selects the v2 provider card
  (`input[name="ccc-provider"][value="claude"]`), picks the newest Opus option by label,
  clicks the Ultracode effort pill, and scrolls Session startup into view — matching the
  rewritten tour text.

## Operational notes

- Capture runs on the Hyper-V VM only (owner re-affirmed: anything that launches the app,
  including `npm run capture-training`, never runs in their Windows session).
- The run takes ~75 s + a teardown hang: a live child outlives `app.close()`, so the node
  process never exits. Kill `electron`/`node` on the VM once the log prints
  "All screenshots captured." — cleanup ("Done.") has already run by then.
- Result: 16 assets refreshed (+ `docs/screenshots/session-config.jpg`), verified clean of
  real identity/spend before commit. Captures carry a DEV badge (unpackaged build) —
  cosmetic, owner aware.

## Follow-ups

- `step-accounts.jpg` / `step-ai-usage.jpg` / `step-sentinel.jpg` are referenced by
  training-steps.ts but have never had assets (tour falls back to the bullet view).
  Capturing them needs demo seeds for the Accounts / AI-usage / Sentinel surfaces.
- The `-mac` variants still need a Mac capture run.
- `settings.json`'s cleanup fingerprint (`Dev Workstation` / `Mac Mini`) doesn't match the
  seeded content (`Demo Workstation`), so cleanup logs a harmless "refusing to delete"
  inside the throwaway root. Cosmetic now that the root is disposable.
