# Mode matrix: e2e evidence

This file records the end-to-end runs that `tests/wp1/traceability.json` names as evidence for
WP1.1 and WP1.60, and that the legacy-Codex ledger cites for its two adapted e2e specs (WP1.58:
`tests/e2e/codex-session-creation.spec.ts` and `tests/e2e/codex-settings-section.spec.ts`; the
ledger row for the first also cites WP1.2, whose own evidence is
`docs/wp1/evidence/real-cli-matrix.md`, not recorded yet, and not this file).

It is a partial record. WP1.1 and WP1.60 stay `planned` in the traceability manifest: WP1.60's
upgrade, restart, enable/disable and minimum real-launch modes are not covered here (see "Not
covered").

## The run recorded here

- Code: commit `5a3e02781d43b5ea2883d39a2f0590f77be1cab5` with this change's visual fixes applied
  on top as an uncommitted patch (`git apply`, clean). The fixes that came after this run (the
  window-close dialogs and the "Closing..." overlay also hide the native panes) and the ledger and
  manifest refresh are not in it. The final head is run again before merge, and this record is
  updated with that commit.
- Date: 2026-09-25 (VM local clock 2026-09-24 23:02-23:12 PDT).
- Machine: Windows 11 Hyper-V test VM (Windows 11 Enterprise Evaluation 10.0.22621, x64).
- Toolchain: Node v24.16.0, Electron 43.7.1, @playwright/test 1.62.1, app 2.1.1-beta.1.
- Build: `npm ci`, `node node_modules\electron\install.js`, `npm run build` (exit 0). The
  postinstall `electron-rebuild` of node-pty and better-sqlite3 fails on the VM with MSB8040
  (Spectre-mitigated libraries are not installed there); both modules load their shipped N-API
  win32-x64 prebuilds, so the run is unaffected.
- Codex on the machine: the VM has a real Codex CLI 0.142.4 on its PATH, below the app's minimum
  (`CODEX_MIN_SUPPORTED_VERSION`, 0.153.4, `src/main/providers/codex/cli-contract.ts`). It was
  left on the runner's PATH for every spec.
- Actor: the VM operator agent (Claude Code), driving the VM over SSH.

## Isolation (every run)

The e2e helper's `CCC_E2E_DATA_DIR` isolates the data and resources folders and `--user-data-dir`
isolates Electron. App boot also touches `~/.claude` (`src/main/index.ts:561`, the statusline heal;
`src/main/index.ts:874-878`, the stale sidecar sweep) and a session writes
`~/.claude/settings-<sid>.json`, so every run here also set `USERPROFILE` and `HOME` to a fresh
throwaway folder and cleared `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. No run read or wrote the VM's
real `~/.claude`, `~/.codex`, app data or registry.

## Gate specs

Command (PowerShell, repo root, the throwaway home exported first, PATH untouched):
`npx playwright test tests/e2e/codex-session-creation.spec.ts tests/e2e/model-picker.spec.ts tests/e2e/codex-settings-section.spec.ts --reporter=list --workers=1`

| Spec | Test | Result |
|---|---|---|
| codex-session-creation.spec.ts | the Provider cards: Codex on Local, refused over SSH in both directions | PASS |
| codex-session-creation.spec.ts | a Codex config is created bound to the Codex account, and listed in the Saved tab | PASS |
| model-picker.spec.ts | a pinned versioned row is selectable and round-trips into the persisted config | PASS |
| codex-settings-section.spec.ts | Settings has no Codex tab; Settings, Accounts shows the Codex row with its status | PASS |

4 passed, 0 failed, 0 skipped.

`codex-session-creation.spec.ts` controls which Codex the app sees
(`tests/e2e/helpers/fake-codex.ts`): a fake at the pinned version first on the app instance's PATH,
every folder holding a real Codex removed from that PATH. Its second test asserts that main
discovered the fake at 0.155.1 (supported) before it creates the config, so the pass shows the app
did not use the machine's 0.142.4. An independent check with the helper's own `fakeCodexEnv`,
following the app's Windows lookup order (`where codex.exe`, then `where codex.cmd`,
`src/main/providers/codex/spawn.ts`): on the runner's PATH, `codex.exe` resolves to the real CLI
under `...\AppData\Local\Programs\OpenAI\Codex\bin`; on the app instance's PATH, `codex.exe`
resolves to nothing and `codex.cmd` to the fake, the first PATH entry. The only folder removed from
PATH was `...\OpenAI\Codex\bin`.

## The rest of the e2e suite (same code, same isolation)

Command: `npx playwright test <the other 18 tracked specs> --reporter=list --workers=1`.

| Spec | Tests | Result |
|---|---|---|
| agent-canvas-frame-security | 5 | PASS |
| app-launch | 8 | PASS |
| artifacts-button-click | 1 | PASS |
| artifacts-button | 1 | PASS |
| cloud-agents | 10 | PASS |
| debug-log-bounded | 1 | PASS |
| first-launch-whats-new | 4 | PASS |
| footer-account-wrap | 2 | PASS |
| github-oauth-ui | 2 | PASS |
| github-panel | 3 | PASS |
| navigation | 8 | PASS |
| pty-launch-hold | 1 | PASS |
| session-dialog-permutations | 8 | 7 PASS, 1 FAIL (and on retry) |
| session-restore | 3 | PASS |
| session-resume-tracking | 2 | PASS |
| ssh-mouse-selection | 1 | PASS |
| terminal-links | 2 | PASS |
| views | 11 | PASS |

Totals, all 21 tracked specs: 77 tests, 76 passed, 1 failed, 0 skipped, 0 flaky.

The one failure is the environment, not the code. `session-dialog-permutations.spec.ts:224` (the
terminal-only secret argument) received `--token` with no value. The secret is stored through
Electron `safeStorage` (DPAPI), and under the VM's key-authenticated OpenSSH logon DPAPI is not
available: a direct probe in the same logon returned `isEncryptionAvailable() = false` and
"Encryption is not available". This test needs an interactive desktop logon to count, and is not
evidence either way from this run.

## Modes exercised in the real app (driven, not gating)

Driven with Playwright `_electron` against `out/main/index.js`, with a fresh isolated data dir and
throwaway home for each run and the window at the app's minimum size, 1280x720. The Codex CLI was
the repo's own fake from `tests/wp1/fake-cli.test.ts` (its `FAKE` script and npm-style `.cmd` shim;
the one change: `--version` reads its version from a side file), and "Run in a terminal" typed into
a fake `npm.cmd`. No real Codex session was launched, and nothing here stands in for
`docs/wp1/evidence/real-cli-matrix.md`.

| Mode | Path | Result |
|---|---|---|
| Fresh, Codex only (no `claude` on PATH) | "Claude Code is not installed" -> Use Codex only -> Welcome -> showcase -> assistants (Codex only) -> command bar -> Set up Codex: CLI not found -> Run in a terminal (steps aside, and back) -> too old -> ready to sign in -> Sign in with ChatGPT -> name -> signed in -> Hello Codex -> GitHub ... Finish -> app | reached; Settings, Accounts shows Claude Code Off and Codex 0.155.1 ready; the Hello Codex replay opens, and Escape closes it |
| Fresh, Codex only, Codex set up after onboarding | Set up Codex skipped -> app -> Settings, Accounts: Check again, Add account, sign in -> the one-time Hello Codex takeover opens | reached |
| Fresh, Claude found | Claude CLI Setup (the terminal has the focus; skipped) -> Welcome -> assistants with Claude, Codex and Both all selectable (Both by default) | reached |
| Fresh, Codex only, this computer already signed in | Set up Codex settles on "Using this sign-in" and "Add a new Codex account (Recommended)"; Hello Codex is correctly not due (an external sign-in) | reached, in the first run only (commit `accec3c2`, no patch) |

## Not covered

Upgrade, restart, enable/disable round trips, and a minimum launch smoke of a real Codex session:
the rest of WP1.60's modes.

WP1.1 (a fresh Claude-only setup reaches a usable app without Codex installed): its planned tests,
`tests/wp1/mode-matrix.test.ts` and `tests/e2e/onboarding-provider-select.spec.ts`, do not exist
yet, and the "Fresh, Claude found" row above stops at the assistants page and does not record whether
Codex was absent, so it is not WP1.1 evidence.

## History

### `accec3c2`, no patch (2026-09-25, VM local 20:31-20:36 PDT)

- `codex-settings-section`: PASS. `codex-session-creation`: both tests SKIPPED. Their entry,
  `button:has-text("New Terminal Config")`, no longer existed in `src/renderer`, so the spec proved
  nothing; it has since been adapted.
- The whole suite (the two specs above included): 73 passed, 2 failed (`model-picker.spec.ts:124`, a stale Saved-tab
  expectation, since adapted; and the DPAPI secret test above), 2 skipped (the two above), 0
  flaky; 77 tests in 21 specs.

### `accec3c2` with the first visual-fixes patch (2026-09-25, VM local 22:18-22:21 PDT)

- `codex-settings-section`, `model-picker`: PASS. `codex-session-creation`: test 1 PASS; test 2
  FAIL with the VM's Codex 0.142.4 on PATH ("Update Codex to launch this config",
  `src/renderer/components/SessionDialog.tsx:438`), PASS with it removed from PATH. Fixed by the
  spec's own fake Codex (above).
