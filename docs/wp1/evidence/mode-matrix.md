# Mode matrix: e2e evidence

This file is evidence for WP1.1 and WP1.60 (`docs/wp1/evidence/mode-matrix.md`). It also covers the two adapted e2e specs that the legacy-Codex ledger places in this gate (WP1.58):
- `tests/e2e/codex-session-creation.spec.ts`
- `tests/e2e/codex-settings-section.spec.ts`

The ledger also cites WP1.2. Its evidence is `docs/wp1/evidence/real-cli-matrix.md`, not this file.

It is a partial record. WP1.1 and WP1.60 stay `planned` in the traceability manifest: WP1.60's upgrade, restart, enable/disable and minimum real-launch modes are not covered here (see "Not covered").

**Current record:** commit `0cb1bf31bf1f090c7fadd902c41219b0e2a36fa9`, the WP2 final candidate head, with no patch applied. Earlier runs are kept below as history.

- Date: 2026-09-25 (VM local clock 15:47:21-15:49:56 PDT).
- Commit: `0cb1bf31bf1f090c7fadd902c41219b0e2a36fa9` (`origin/session/beta/c4d568ce-wp2-codex`).
  - The VM checkout was reset to that full sha and verified against the fetched remote head; it has 0 tracked changes.
  - `out/main/index.js` was built from it at 15:46:05.
- Changes since the previous record (`633d37db`):
  - `c8079555`, `844a736d`, `229f3d9c`: docs.
  - `9eba7983`: End for a rootful container session started without a saved sudo password now says Claude may still be running there and shows the command to stop it (`src/main/pty-manager.ts`, `src/main/providers/claude/ssh-shim.ts`, `src/main/ipc/pty-handlers.ts`, `src/preload/index.ts`, and the renderer notice).
  - `66328f15`: the main process no longer exits when node-pty throws "Cannot resize a pty that has already exited" from a resize it queued (`src/main/debug-logger.ts`).
  - `c55ba0c7`: front-facing docs and in-app copy for Codex (README, user guide, app-knowledge, tips, Feature Guide, guided tour, Hello Codex), and the `package.json` description.
  - `0cb1bf31`: the legacy Codex ledger and manifest brought in step with that sweep, and two app-knowledge sentences shortened.
  - None of them touches an e2e spec.
- Machine: Hyper-V VM WinDev2407Eval, Windows 11 Enterprise Evaluation 10.0.22621 (build 22621), 64-bit.
- Toolchain: Node v24.16.0, Electron 43.7.1, @playwright/test 1.62.1, app 2.1.1-beta.1. The lockfile is unchanged since `38cbc9d7`; `package.json` changed only its description.
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

The line numbers are the same at `38cbc9d7`, `36b83da1`, `633d37db`, `229f3d9c`, `c55ba0c7` and `0cb1bf31` (`src/main/index.ts` is unchanged since `633d37db`).

So every run here also set `USERPROFILE`/`HOME` to a fresh throwaway folder, and cleared `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. No run read or wrote the VM's real `~/.claude`, `~/.codex`, app data or registry.

This run's evidence:
- **Before and after snapshots are identical:**
  - Registry: the SHA-256 of `reg query /s` for `HKCU\Software\AI Code Conductor` (84AFE33E30E42D28) and its two legacy keys matched.
  - File counts and newest write times matched for `C:\Users\User\.claude` (520 files, newest 2026-09-24 05:16), `C:\Users\User\.codex` (6472, newest 2026-09-24 08:35) and `...\AppData\Local\AI Code Conductor` (169, newest `debug\app.log` 2026-09-24 23:52:44). The newest write in each is from the day before, so no run of this day wrote there.
- **The fake home got the writes instead.** The run's meta file lists what it received: two `.claude\settings-<sid>.json` session sidecars (`settings-3c228b5792e79d1af21db0e1.json` and `settings-e2e-artifacts-sess.json`) and a PSReadLine history.
- **Leaked data folders:** nine `ccc-e2e-*` folders were left in `%TEMP%`. The helper reported EPERM for seven of them, because Windows had not yet released the handles when it cleaned up. The operator deleted all nine and the fake home afterwards, with no app, Electron or Node process running.
- **Spec list:**
  - The run passed the 21 tracked specs explicitly, from `git ls-files tests/e2e/*.spec.ts`.
  - The VM checkout also holds two untracked, VM-local specs (`dock-mark`, `ssh-pi-pills`), and a bare `npx playwright test` would have picked them up.
  - The 21 passed are the whole suite of the commit.

## Full e2e suite at `0cb1bf31` (no patch)

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

**Totals, all 21 tracked specs: 77 tests, 76 passed, 1 failed, 0 skipped, 0 flaky.** Playwright took 2.5 minutes and exited 1. This is the same result as at `c55ba0c7`, `229f3d9c`, `633d37db`, `36b83da1` and `38cbc9d7`.

**The one failure is an environment limit, not a product bug and not a stale spec.**
- The failing test is `session-dialog-permutations.spec.ts:182` (the terminal-only config runs its command with the secret). It failed on both attempts.
- Expected: `--token|E2E-SECRET-9f3a`. Received: `ARGV=--token`, with an empty value.
- Why the value is empty: the secret is kept in `safeStorage` (DPAPI on Windows). `src/main/credential-store.ts:104` refuses to store it when `safeStorage.isEncryptionAvailable()` is false, so `CCC_ARG_SECRET` resolves to nothing.
- A direct probe, re-run for this record in the same launch context at 15:50, confirmed the cause.
  - The probe was a minimal Electron main script, not the app.
  - Context: created through WMI from the key-authenticated OpenSSH session, a fake home, and a throwaway `--user-data-dir`.
  - The process token's logon group is `NT AUTHORITY\NETWORK`.
  - Result: `isEncryptionAvailable=false`, and `encryptString` threw "Encryption is not available".
- A key-authenticated SSH logon carries no password-derived credentials, so DPAPI cannot open the user's master key.
- The spec's expectation is correct. This test needs an interactive desktop logon to count.
- Its seven sibling tests in the same spec pass.

## Modes exercised in the real app (driven, not gating)

### The End notice for a rootful container, and an app exit it found

A scratch spec (not tracked; copied into the VM checkout for the run and removed after it) drove the real close path of a container session in the built app:
- Setup: an isolated app with one seeded SSH config (rootful podman container `ccc-test`, no saved password or sudo password), dialling `127.0.0.1:1`, so `ssh.exe` starts and is refused at once. Main's `ssh:endRemote` handler was replaced with an immediate `container-needs-sudo` result, so no host was contacted.
- It launched the config from the Saved tab, closed the tab through the real UI, and checked: End was called once for that session; the notice appeared with its text and the stop command; focus sat on the panel; an early Escape was ignored; Copy command reached the clipboard; Escape then closed it and focus returned. It captured the notice in light and dark, at the default size and at 800x700, and the Copied state.

Results:
- At `229f3d9c` the capture never reached End. Its last attempt, the one run with diagnostics, recorded the main process exiting with code 7 while the refused session was still starting. The app log showed an uncaught "Cannot resize a pty that has already exited", thrown from node-pty's `windowsPtyAgent.js` when it ran a resize it had queued before the refused `ssh.exe` exited. Fixed in `66328f15`.
- At `66328f15` (VM local 14:48): the capture passed, 10 of 10 checks, with all six screenshots, and the app exited with code 0. That run did not hit the race: its app log has no such error.
- At `66328f15` again (VM local 14:52), in a loop set to stop at the first run whose app log showed the suppressed error: run 1 hit it. The log line "Uncaught exception (suppressed, resize of an exited pty)" with the node-pty stack was written at 21:52:38 UTC, the app kept running, the capture passed 10 of 10 checks, and the app exited with code 0.
- The screenshots were reviewed by eye: the notice text, the command block and both buttons are readable in both themes, nothing is clipped at 800x700, and the Copied state shows.

### Earlier mode rows

Not re-driven as a mode matrix at `633d37db` or later. The rows below were recorded at `5a3e0278` + visual-fixes-r2.patch; the patch's files (`contain-focus.ts`, `fake-codex.ts`, the adapted `codex-session-creation` spec) have since landed in `4561e643`. The last row was recorded at `accec3c2`.

The VM visual captures at `38cbc9d7`, `36b83da1` and `633d37db` drove further paths, in both themes, recorded in their shot sets rather than here. At `633d37db` one build produced the whole set (`shots7`), across five fresh launches:
- Codex only through onboarding: CLI not found, ready to sign in, the sign-in name dialog, signed in, then Settings, Accounts with Claude Code off.
- Codex set up after onboarding: the one-time Hello Codex takeover, pages 1-5, and the close dialog over it.
- Claude found, both assistants, with this computer already signed in to Codex.
- Claude found, with a newer-than-tested fake Codex (0.157.0): Codex off and on, a Codex account added, the review cards and Code review switches in each state.
- Claude found, with a seeded Claude profile: the Settings tabs, the account colour swatches, the rename field and the sign-in select, each focused by keyboard.

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

### `c55ba0c7` without a patch (2026-09-25, VM local 15:32:57-15:36:01 PDT)

- Same machine, toolchain, build quirks and isolation as the current record.
  - `out/main/index.js` was built at 15:31:05.
  - The before and after snapshots of the real registry, `~/.claude`, `~/.codex` and app data were identical.
  - Nine `ccc-e2e-*` folders were in `%TEMP%` after this run and the End notice captures before it, and the helper reported EPERM for seven during the run. The operator deleted them and both fake homes.
- All 21 tracked specs: 77 tests, 76 passed, 1 failed, 0 skipped, 0 flaky. The run took 3.0 minutes.
  - Gate specs: 4 passed.
  - The failure was the DPAPI secret test (`session-dialog-permutations.spec.ts:182`), with the same cause. A probe in that launch context at 15:37 (`NT AUTHORITY\NETWORK`) returned `isEncryptionAvailable=false`.

### `229f3d9c` without a patch (2026-09-25, VM local 13:54:18-13:56:54 PDT)

- Same machine, toolchain, build quirks and isolation as the current record.
  - `out/main/index.js` was built at 13:50:47.
  - The before and after snapshots of the real registry, `~/.claude`, `~/.codex` and app data were identical.
- All 21 tracked specs: 77 tests, 76 passed, 1 failed, 0 skipped, 0 flaky. The run took 2.6 minutes.
  - Gate specs: 4 passed.
  - The failure was the DPAPI secret test (`session-dialog-permutations.spec.ts:182`), with the same cause. A probe in that launch context at 13:58 returned `isEncryptionAvailable=false`.

### `633d37db` without a patch (2026-09-25, VM local 06:00:32-06:03:01 PDT)

- Same machine, toolchain, build quirks and isolation as the current record.
  - `out/main/index.js` was built at 05:49:31. The same build is the source of the one-commit visual evidence set (`shots7`).
  - The before and after snapshots of the real registry, `~/.claude`, `~/.codex` and app data were identical. A final sweep found 0 files written after 02:50 in those folders.
  - Ten `ccc-e2e-*` folders were left, and the helper reported EPERM for seven of them.
- All 21 tracked specs: 77 tests, 76 passed, 1 failed, 0 skipped, 0 flaky. The run took 2.3 minutes.
  - Gate specs: 4 passed.
  - The failure was the DPAPI secret test (`session-dialog-permutations.spec.ts:182`), with the same cause. A probe in that launch context at 06:03 (`NT AUTHORITY\NETWORK`) returned `isEncryptionAvailable=false`.

### `36b83da1` without a patch (2026-09-25, VM local 04:31:10-04:33:45 PDT)

- Same machine, toolchain, build quirks and isolation as the current record.
  - `out/main/index.js` was built at 04:22:21.
  - The before and after snapshots of the real registry, `~/.claude`, `~/.codex` and app data were identical.
  - Nine `ccc-e2e-*` folders were left, and the helper reported EPERM for seven of them.
- All 21 tracked specs: 77 tests, 76 passed, 1 failed, 0 skipped, 0 flaky. The run took 2.5 minutes.
  - Gate specs: 4 passed.
  - The failure was the DPAPI secret test (`session-dialog-permutations.spec.ts:182`), with the same cause. A probe in that launch context at 04:35 (`NT AUTHORITY\NETWORK`) returned `isEncryptionAvailable=false`.

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
