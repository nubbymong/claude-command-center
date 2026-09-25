# Mode matrix: e2e evidence

This file is evidence for WP1.1 and WP1.60 (`docs/wp1/evidence/mode-matrix.md`). It also covers the two adapted e2e specs that the legacy-Codex ledger places in this gate (WP1.58):
- `tests/e2e/codex-session-creation.spec.ts`
- `tests/e2e/codex-settings-section.spec.ts`

The ledger also cites WP1.2. Its evidence is `docs/wp1/evidence/real-cli-matrix.md`, not this file.

It is a partial record. WP1.1 and WP1.60 stay `planned` in the traceability manifest: WP1.60's upgrade, restart, enable/disable and minimum real-launch modes are not covered here (see "Not covered").

**Current record:** commit `36b83da1d8a34ab34a6f34925336bd51c4290242`, the WP2 head after the accessibility fixes from the VM capture, with no patch applied. Earlier runs are kept below as history.

- Date: 2026-09-25 (VM local clock 04:31:10-04:33:45 PDT).
- Commit: `36b83da1d8a34ab34a6f34925336bd51c4290242` (`origin/session/beta/c4d568ce-wp2-codex`).
  - The VM checkout was reset to that full sha and verified against the fetched remote head; it has 0 tracked changes.
  - `out/main/index.js` was built from it at 04:22:21.
- Changes since the previous record (`38cbc9d7`):
  - `b8999772`: docs.
  - `ea63ff78`: a unit test.
  - `36b83da1`: renderer styling. Focus rings, status-pill and badge colours, and the Conductor MCP header copy.
  - None of them touches `src/main`, the preload or the e2e specs.
- Machine: Hyper-V VM WinDev2407Eval, Windows 11 Enterprise Evaluation 10.0.22621 (build 22621), 64-bit.
- Toolchain: Node v24.16.0, Electron 43.7.1, @playwright/test 1.62.1, app 2.1.1-beta.1. The lockfile is unchanged since `38cbc9d7`.
- Build:
  - `npm ci` exits 255. Its postinstall `electron-rebuild` of node-pty and better-sqlite3 fails with MSB8040, because the Spectre-mitigated libraries are not installed on the VM. Both modules load their shipped N-API win32-x64 prebuilds, so the run is unaffected.
  - `npm ci` left Electron's binary missing, and `node node_modules\electron\install.js` restored it.
  - `npm run build` exited 0.
- Codex on the machine: the VM's real Codex CLI (`...\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`) stayed on the runner's PATH, as in every earlier record.
  - An earlier record gives its version as 0.142.4. It was not run here, because a Rust CLI may resolve its home through the Windows profile API rather than `USERPROFILE`.
  - `codex-session-creation` supplies its own fake Codex (`tests/e2e/helpers/fake-codex.ts`).
- Actor: the VM operator agent (Claude Code), driving the VM over SSH. The runner was launched detached through WMI `Win32_Process.Create`.

## Isolation (every run)

The e2e helper's `CCC_E2E_DATA_DIR` isolates the data and resources folders, and `--user-data-dir` isolates Electron. App boot still touches `~/.claude`:
- the statusline heal at `src/main/index.ts:561`;
- the stale sidecar sweep at `:876-880`;
- a session writes `~/.claude/settings-<sid>.json`.

The line numbers are the same at `38cbc9d7` and `36b83da1`.

So every run here also set `USERPROFILE`/`HOME` to a fresh throwaway folder, and cleared `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. No run read or wrote the VM's real `~/.claude`, `~/.codex`, app data or registry.

This run's evidence:
- **Before and after snapshots are identical:**
  - Registry: the SHA-256 of `reg query /s` for `HKCU\Software\AI Code Conductor` (84AFE33E30E42D28) and its two legacy keys matched.
  - File counts and newest write times matched for `C:\Users\User\.claude` (520 files, newest 2026-09-24 05:16), `C:\Users\User\.codex` (6472, newest 2026-09-24 08:35) and `...\AppData\Local\AI Code Conductor` (169, newest `debug\app.log` 2026-09-24 23:52:44).
- **The final sweep** found 0 files written after 02:50 in those three folders. That window covers every run of the day.
- **The fake home got the writes instead.** It received two `.claude\settings-<sid>.json` session sidecars and a PSReadLine history.
- **Leaked data folders:** nine `ccc-e2e-*` folders were left in `%TEMP%`. The helper reported EPERM for seven of them, because Windows had not yet released the handles when it cleaned up. The operator deleted all nine and the fake home after the run.
- **Spec list:**
  - The run passed the 21 tracked specs explicitly, from `git ls-files tests/e2e/*.spec.ts`.
  - The VM checkout also holds two untracked, VM-local specs (`dock-mark`, `ssh-pi-pills`), and a bare `npx playwright test` would have picked them up.
  - The 21 passed are the whole suite of the commit.

## Full e2e suite at `36b83da1` (no patch)

Command (PowerShell, repo root, fake home exported first, PATH untouched):

`npx playwright test <the 21 tracked specs> --reporter=list --workers=1`

The config has `retries: 1`.

Gate specs:

| Spec | Test | Result |
|---|---|---|
| codex-session-creation.spec.ts | the Provider cards: Codex on Local, refused over SSH in both directions | PASS |
| codex-session-creation.spec.ts | a Codex config is created bound to the Codex account, and listed in the Saved tab | PASS |
| model-picker.spec.ts | a pinned versioned row is selectable and round-trips into the persisted config | PASS |
| codex-settings-section.spec.ts | Settings has no Codex tab; Settings, Accounts shows the Codex row with its status | PASS |

The second `codex-session-creation` test asserts that main discovered the spec's fake Codex at 0.155.1 (supported). Its pass therefore also shows that the app did not use the machine's older real Codex.

Rest of the suite:

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

**Totals, all 21 tracked specs: 77 tests, 76 passed, 1 failed, 0 skipped, 0 flaky.** Playwright took 2.5 minutes and exited 1. This is the same result as at `38cbc9d7`.

**The one failure is an environment limit, not a product bug and not a stale spec.**
- The failing test is `session-dialog-permutations.spec.ts:182` (the terminal-only config runs its command with the secret). It failed on both attempts.
- Expected: `--token|E2E-SECRET-9f3a`. Received: `ARGV=--token`, with an empty value.
- Why the value is empty: the secret is kept in `safeStorage` (DPAPI on Windows). `src/main/credential-store.ts:104` refuses to store it when `safeStorage.isEncryptionAvailable()` is false, so `CCC_ARG_SECRET` resolves to nothing.
- A direct probe, re-run for this record in the same launch context at 04:35, confirmed the cause.
  - The probe was a minimal Electron main script, not the app.
  - Context: created through WMI from the key-authenticated OpenSSH session, a fake home, and a throwaway `--user-data-dir`.
  - The process token's logon group is `NT AUTHORITY\NETWORK`.
  - Result: `isEncryptionAvailable=false`, and `encryptString` threw "Encryption is not available".
- A key-authenticated SSH logon carries no password-derived credentials, so DPAPI cannot open the user's master key.
- The spec's expectation is correct. This test needs an interactive desktop logon to count.
- Its seven sibling tests in the same spec pass.

## Modes exercised in the real app (driven, not gating)

Not re-driven as a mode matrix at `36b83da1`. The rows below were recorded at `5a3e0278` + visual-fixes-r2.patch; the patch's files (`contain-focus.ts`, `fake-codex.ts`, the adapted `codex-session-creation` spec) have since landed in `4561e643`. The last row was recorded at `accec3c2`.

The VM visual captures at `38cbc9d7` and `36b83da1` drove one more path each, in both themes, recorded in their shot sets rather than here. That path was:
- Claude found, both assistants;
- Set up Codex with a newer-than-tested fake Codex (0.157.0);
- Codex off and on in Settings, Accounts;
- a Codex account added;
- the one-time Hello Codex takeover.

The driving setup for the rows below:
- Playwright `_electron` against `out/main/index.js`, with a fresh isolated data dir and fake home for each run, and the window at the app's minimum.
- The Codex CLI was the repo's own fake from `tests/wp1/fake-cli.test.ts`: its `FAKE` script and npm-style `.cmd` shim. The only change is that `--version` reads a side file.
- "Run in a terminal" typed into a fake `npm.cmd`.
- No real Codex session was launched, and nothing here stands in for `real-cli-matrix.md`.

| Mode | Path | Result |
|---|---|---|
| Fresh, Codex only (no `claude` on PATH) | "Claude Code is not installed" -> Use Codex only -> Welcome -> showcase -> assistants (Codex only) -> command bar -> Set up Codex: CLI not found -> Run in a terminal (steps aside, back) -> too old -> ready to sign in -> Sign in with ChatGPT -> name -> signed in -> Hello Codex -> GitHub ... Finish -> app | reached. Settings, Accounts shows Claude Code Off and Codex 0.155.1 ready. The replay opens, and Escape closes it. |
| Fresh, Codex only, Codex set up after onboarding | Set up Codex skipped -> app -> Settings, Accounts: Check again, Add account, sign in -> the one-time Hello Codex takeover opens | reached |
| Fresh, Claude found | Claude CLI Setup (terminal focused; skipped) -> Welcome -> assistants with Claude, Codex, Both all selectable (default Both) | reached |
| Fresh, Codex only, this computer already signed in | Set up Codex settles on "Using this sign-in" + "Add a new Codex account (Recommended)"; Hello Codex is correctly not due (external sign-in) | reached (first run, `accec3c2`) |

Not covered here, for WP1.60's other modes:
- upgrade;
- restart;
- enable and disable round trips;
- a minimum launch smoke of a real Codex session.

## History

### `38cbc9d7` without a patch (2026-09-25, VM local 03:07:09-03:10:17 PDT)

- Same machine, toolchain, build quirks and isolation as the current record.
  - The before and after snapshots of the real registry, `~/.claude`, `~/.codex` and app data were identical.
  - Nine `ccc-e2e-*` folders were left, and the helper reported EPERM for seven of them. The earlier write-up of this record said six; seven is the count of distinct folders the helper named.
- All 21 tracked specs: 77 tests, 76 passed, 1 failed, 0 skipped, 0 flaky. The run took 3.1 minutes.
  - Gate specs (`codex-session-creation` x2, `model-picker`, `codex-settings-section`): 4 passed.
  - The failure was the DPAPI secret test (`session-dialog-permutations.spec.ts:182`), with the same cause. A direct probe in that launch context (`NT AUTHORITY\NETWORK`) returned `isEncryptionAvailable=false`.

### `5a3e0278` + visual-fixes-r2.patch (2026-09-25, VM local 2026-09-24 23:02-23:12 PDT)

- Gate specs (`codex-session-creation` x2, `model-picker`, `codex-settings-section`): 4 passed.
  - `codex-session-creation` controlled which Codex the app saw, through `fake-codex.ts` (0.155.1).
  - An independent check with the helper's `fakeCodexEnv` showed:
    - on the runner's PATH, `codex.exe` resolved to the real 0.142.4;
    - on the app instance's PATH, `codex.exe` resolved to nothing, and `codex.cmd` to the fake, which is the first PATH entry;
    - the only folder removed from PATH was `...\OpenAI\Codex\bin`.
- Rest of the suite (18 specs): 73 passed, 1 failed. The failure was the same DPAPI secret test (`session-dialog-permutations.spec.ts:224`), with the same cause. A direct probe in that logon returned `isEncryptionAvailable() = false`.
- Totals, all 21 tracked specs: 77 tests, 76 passed, 1 failed, 0 skipped, 0 flaky.

### `accec3c2` without a patch (2026-09-25, VM local 20:31-20:36 PDT)

- `codex-settings-section`: PASS.
- `codex-session-creation`: both tests SKIPPED. Its entry point, `button:has-text("New Terminal Config")`, no longer exists in `src/renderer`, so the spec proved nothing.
- Rest of the suite: 73 passed, 2 failed, 2 skipped (the two above), 0 flaky, across 77 tests in 21 specs. The two failures:
  - `model-picker:124`, a stale Saved-tab expectation, since adapted;
  - the DPAPI secret test above.

### `accec3c2` + visual-fixes.patch (2026-09-25, VM local 22:18-22:21 PDT)

- `codex-settings-section` and `model-picker`: PASS.
- `codex-session-creation`: test 1 PASS. Test 2:
  - FAIL with the VM's Codex 0.142.4 on PATH ("Update Codex to launch this config", `src/renderer/components/SessionDialog.tsx:438`);
  - PASS with it removed from PATH.
  - Fixed in r2 by the spec's own fake Codex (above).
