# Skip and flaky ledger

This file is evidence for WP1.65 in `tests/wp1/traceability.json` ("No unexplained failing, skipped, quarantined or flaky test", kind document). It is a reviewed record derived from a CI run. For each skipped or todo test the run reported, it gives the condition in the test source that skips it, and where the skipped case runs instead.

**Status: the first record, from CI run 37134624406, is below. WP1.65 stays `planned` in the traceability manifest until the candidate run at the binding's head is recorded here the same way (the candidate declaration, made at release).**

## The run

- CI run 37134624406 (`pull_request`, attempt 1, 2026-10-03), at commit fcfd2ae60b9174a15768c443056b068f4a9d61a3 (PR 628). It ran as GitHub's merge with beta (6a07c3fb74a255266b04234482323760bb9a6da1). `docs/wp1/evidence/ci-matrix.md` (Results) records the same run.
- Jobs read:
  - `Test (windows-2025)` (job 111236523318), `Test (macos-latest)` (job 111236523233) and `Test (ubuntu-latest)` (job 111236523243). Each runs `npx vitest run`, then `npm run test:unit:native`.
  - The six codex-conformance legs, for the two files that run there.
- Source: every condition is cited at fcfd2ae6. Every file below is unchanged from there to f73f1785, the branch head this record was written at, except `tests/integration/codex-real-cli-conformance.test.ts`. That file is cited at its current lines, and the row also gives fcfd2ae6's lines. Beta's side of the merge (6a07c3fb) is not in the local clone and was not read. The conditions at fcfd2ae6 explain every count below.

### Totals, the log against this ledger

| OS | vitest files | vitest tests | native (`test:unit:native`) | Explained below |
|---|---|---|---|---|
| Windows | 1,189: 1,184 passed, 5 skipped | 17,391: 17,313 passed, 76 skipped, 2 todo | 14 files, 225 passed | 76 skipped, 2 todo, 0 native; the 5 skipped files are the 5 rows marked "all" for Windows |
| macOS | 1,189: 1,183 passed, 6 skipped | 17,391: 17,315 passed, 74 skipped, 2 todo | 14 files, 217 passed, 8 skipped | 74 skipped, 2 todo, 8 native; 6 skipped files |
| Linux | 1,189: 1,182 passed, 7 skipped | 17,391: 17,307 passed, 82 skipped, 2 todo | 14 files, 217 passed, 8 skipped | 82 skipped, 2 todo, 8 native; 7 skipped files |

Each codex-conformance leg ran `codex-real-cli-conformance.test.ts` (8 passed, 1 skipped: the placeholder below) and `codex-cli-compat.test.ts` (5 passed, none skipped).

How the counts were read: vitest's default reporter prints, per file, how many cases skipped (`(N tests | M skipped)`), and marks a file whose cases all skipped with a down arrow. It does not say which cases skipped. Where a file has one skip condition per OS, the count identifies the cases. The two shell-compatibility files have several conditions, so their split below is the one the counts allow, not one read from the log (see "Unexplained or to decide").

## Ledger

One row per test file that skipped anything on any OS. A dash means nothing skipped on that OS.

| File | Windows | macOS | Linux | Why it skips (from the source) | Where the skipped cases run |
|---|---|---|---|---|---|
| `tests/integration/codex-cli-compat.test.ts` | 6 (all) | 6 (all) | 6 (all) | Needs a `codex` on PATH (`codexOnPath`, line 30). Without one, `maybeIt` is `it.skip` (lines 63-64) for the 5 flag-drift cases, and a placeholder `it.skip` is registered (lines 112-113). The Test jobs install no Codex. HOST QUARANTINE. | The codex-conformance job: 5 passed on each of the six legs (the placeholder is not registered there) |
| `tests/integration/codex-real-cli-conformance.test.ts` | 9 (all) | 9 (all) | 9 (all) | Needs `CCC_CODEX_CONFORMANCE_BIN` (`LIVE`, lines 53-54). `describe.skipIf(!LIVE)` (line 115) holds the 8 checks; `describe.skipIf(LIVE)` holds a placeholder `it.skip` (lines 257-258). Only the codex-conformance job sets the variable. At fcfd2ae6 the same gates were at lines 51, 108 and 249-250. HOST QUARANTINE. | The codex-conformance job: 8 passed on each of the six legs; the placeholder is skipped there too (1 per leg), by design |
| `tests/integration/hooks/real-claude.test.ts` | 1 (all) | 1 (all) | 1 (all) | Opt-in. Needs `RUN_REAL_CLAUDE_HOOKS_TEST=1`, a `claude` on PATH, and that claude's `--settings` flag (lines 41-44). It spends API tokens, and the comment calls its assertion environmentally flaky (lines 29-38). No CI job sets the variable. | No CI or VM run found. The comment calls it "useful before cutting a beta release" |
| `tests/unit/account-profiles-canonical.test.ts` | 1 | - | - | POSIX mode bits: `posixIt` is `it.skip` on win32 (line 32). The case checks that the credential file is 0o600. | macOS and Linux Test jobs |
| `tests/unit/atomic-write-secure.test.ts` | 2 | - | - | `it.runIf(process.platform !== 'win32')` (lines 145, 153). The cases check 0600 over a loose-moded file, and that O_EXCL rejects a planted symlink. | macOS, Linux |
| `tests/unit/claude-backup.test.ts` | 1 | - | - | `it.runIf(process.platform !== 'win32')` (line 176). The case checks that the backed-up credential copy is 0600. | macOS, Linux |
| `tests/unit/config-secret-permissions.test.ts` | 3 | - | - | `it.runIf(IS_POSIX)` (lines 88, 95, 123; `IS_POSIX` line 54). The cases check 0600 and 0700 modes. | macOS, Linux |
| `tests/unit/console-bleed-verification.test.ts` | 1 | 1 | 1 | `it.skip` (line 90) under `describe('MANUAL: ...')` (line 77): a placeholder. The real-exe check is run by hand with `scripts/verify-console-bleed.mjs`, from a real terminal, on a machine with a Subsystem=2 tool (lines 78-89). | No CI or VM run found; manual only |
| `tests/unit/github/codex-rollout-loader-swap.test.ts` | - | 1 | 1 | Windows only: `it.runIf(process.platform === 'win32')` (line 102). The case reads an input spelled in another case. | Windows |
| `tests/unit/harden-dir-acl-windows.test.ts` | 1 | 9 | 9 | On Windows, the off-Windows case is skipped: `describe.runIf(!IS_WINDOWS)` (line 579), one case. On macOS and Linux, the real DACL block is skipped: `describe.runIf(IS_WINDOWS)` (line 440), 9 cases (two `it.each` pairs at lines 441 and 492, and 5 single cases). `IS_WINDOWS` is at line 44. | Each half runs on the other OS or OSes |
| `tests/unit/logging/transcript-discovery.test.ts` | - | 1 | 1 | Windows only: `it.skipIf(process.platform !== 'win32')` (line 529), a real junction. On Windows it would also skip on a temp volume that cannot hold a junction (line 547); it did not. | Windows |
| `tests/unit/main/canvas-plugin.test.ts` | 1 | - | - | `it.runIf(IS_POSIX)` (line 353; `IS_POSIX` line 57). The case checks that a symlinked owned file is refused. | macOS, Linux |
| `tests/unit/main/claude-cli-version.test.ts` | - | 6 | 6 | Windows only: `describe.runIf(process.platform === 'win32')` (line 302), 6 cases. They need a real Windows PATH entry, npm's shim and cmd.exe. | Windows |
| `tests/unit/main/clipboard-file-copy.test.ts` | - | - | 2 (all) | `describe.runIf(win32 or darwin)` (line 48). The clipboard file formats are read only on Windows (CF_HDROP) and macOS (line 47). | Windows, macOS. Linux has no such path, by design |
| `tests/unit/main/codex-name-sidecar.test.ts` | - | 1 | 1 | Windows only: `it.runIf(process.platform === 'win32')` (line 143). | Windows |
| `tests/unit/main/container-entry-shell-compat.test.ts` | 5 | 3 | 4 | A missing shell skips its cases by name (`have`, line 28): the five host shells (line 63; bash, sh, dash, zsh, fish at line 32), the 3 x 2 container pairs by outer shell (line 79; outer sh, dash, busybox at line 33), and two `sh` cases (lines 90, 96). Two more cases depend on whether the runner's shell reads startup files first (`preSourcesStartup`, line 117): `sh -c` and `dash -c` skip where that shell reads `BASH_ENV`/`ENV` before its body (line 134), and the negative control skips where `bash -c` does not (line 147). The splits the counts allow: macOS 3 = fish (1) + busybox (2); Linux 4 = zsh and fish (2) + busybox (2); Windows 5 = zsh and fish (2) + busybox (2) + one startup-file case (line 134 or 147). The owner's Windows host skipped 4 here for zsh, fish and busybox (`docs/wp1/baseline-2026-09-19.md`). | zsh runs on macOS. The fish and busybox cases: no CI or VM run found. The file says the live SSH matrix covers zsh, fish and busybox on the fleet hosts (line 15) |
| `tests/unit/main/installer-nsis-behaviour.test.ts` | 13 | 13 | 13 | Needs makensis: `describe.skipIf(!MAKENSIS)` (line 395), 11 cases plus a loop of 2 (lines 572-576). `findMakensis` (line 70) returns null off Windows (line 71). On Windows it looks only at `MAKENSIS`, electron-builder's NSIS cache and an NSIS install (lines 72-90), and the windows-2025 runner had none of them. `ci.yml` packages only on `release/*` branches, after the tests, and `release.yml`'s build-windows also runs vitest before electron-builder. The availability tripwire (line 97) ran and passed. | No CI or VM run found. It runs only on a Windows machine that has makensis, such as one where electron-builder has packaged the app |
| `tests/unit/main/owner-only-folders-real.test.ts` | - | 4 (all) | 4 (all) | Windows only: `describe.runIf(IS_WIN)` (line 66). The cases read real rights with icacls and Windows PowerShell. HOST QUARANTINE. | Windows Test job (4 passed) |
| `tests/unit/main/owner-only-folders.test.ts` | 1 | - | - | `describe.runIf(process.platform !== 'win32')` (line 282), one case: `secureFoldersPosix` 0700. | macOS, Linux |
| `tests/unit/main/per-session-mcp-secret-mode.test.ts` | 2 | - | - | `it.runIf(IS_POSIX)` (lines 98, 105; `IS_POSIX` line 67). | macOS, Linux |
| `tests/unit/main/profile-id.test.ts` | - | 1 | 1 | Windows only: `it.runIf(process.platform === 'win32')` (line 123), an 8.3 short name. | Windows |
| `tests/unit/main/session-hooks-writer-secret-mode.test.ts` | 1 | - | - | `it.runIf(IS_POSIX)` (line 78; `IS_POSIX` line 53). | macOS, Linux |
| `tests/unit/main/ssh-end-remote-shell-compat.test.ts` | 18 (all) | 3 | 8 | POSIX only: three `describe.skipIf(!POSIX)` blocks (lines 143, 193, 209; `POSIX` line 49). The line runs on the SSH host, and Git Bash cannot stand in for it (lines 31-33). Within the blocks, a missing shell skips its cases by name (`have`, line 85): each host shell (bash, sh, dash, zsh, fish) gates 3 cases (lines 147, 160, 199), each csh shell (tcsh, csh) gates 1 (line 177), and `sh` gates 1 more (line 210). The counts allow one split each. macOS 3 = one host shell missing, 3 cases (fish: macOS ships the other four, so this is the one assumed missing). Linux 8 = two host shells missing, 6 cases (zsh and fish; Ubuntu has bash, sh and dash), plus tcsh and csh, 2 cases. | zsh, tcsh and csh run on macOS. The fish cases: no CI or VM run found |
| `tests/unit/native/tokenomics-reindex-accounts.native.test.ts` (native run) | - | 8 | 8 | Windows only: the "by its 8.3 short name" base (lines 210-224) is null off Windows (line 211), and `baseOr` skips (line 228). That base covers 4 cases x 2 folder orders (lines 232-233) = 8. | Windows native run (225 passed) |
| `tests/unit/providers/codex/conversation-carry.test.ts` | - | 1 | 1 | Windows only: `ctx.skip()` off win32 (line 1004), an 8.3 short-named resources folder. On Windows it would also skip on a volume without short names (line 1011); the file-link case (line 232) skips without the right to make a file link (line 238). Neither happened on the runner. | Windows |
| `tests/unit/providers/codex/hook-wrapper-start-folder.test.ts` | - | 2 (all) | 2 (all) | Windows only: `describe.runIf(IS_WIN)` (line 57), a loop of 2 (line 58). The cases run the `.cmd` wrapper under cmd.exe. HOST QUARANTINE. | Windows Test job (2 passed) |
| `tests/unit/providers/codex/hooks.test.ts` | 1 | - | - | `it.runIf(process.platform !== 'win32')` (line 543). The case checks that a launch applies 0700 to the prepared root again. | macOS, Linux |
| `tests/unit/providers/codex/spawn-hooks.test.ts` | - | 3 | 3 | Windows only: `it.runIf(process.platform === 'win32')` (lines 180, 196, 230). The last two also skip on a Windows host whose test folders have no plain-word path (lines 202, 234); they did not. | Windows |
| `tests/unit/providers/codex/telemetry-exact-claim.test.ts` | - | 1 | 1 | Windows only: `it.runIf(process.platform === 'win32')` (line 250). The junction and file-link case (line 164) skips only on EPERM (lines 180, 194); it did not. | Windows |
| `tests/unit/renderer/commandbar-menus.test.tsx` | 2 todo | 2 todo | 2 todo | `it.todo` (lines 666, 812): two menu items that are not built (see below). | Not tests of anything that exists |
| `tests/unit/scripts/codex-hook-forwarder.test.ts` | 1 | 1 | 1 | The proxy case (line 260) skips when a request on a shared agent given `proxyEnv` does not reach the stand-in proxy, that is, on a Node without environment proxies (line 288). The comment names Node 24 (lines 274-275). CI runs Node 20.20.2 (`actions/setup-node`, `node-version: '20'`), so this case skips on every OS. The file-link case (line 208) skips only without the right to make a file link. Windows ran it: Windows' count is 1, and the Windows runner made file links in other files too. | No CI or VM run found for the proxy case |
| `tests/unit/scripts/codex-resume-picker-worktrees.test.ts` | 1 | - | - | `ctx.skip()` on win32 (line 257). The case checks that the pick file's mode is 0600. The file-link and junction cases (lines 268, 424) skip only without the right to make the link; they ran. | macOS, Linux |
| `tests/unit/sentinel-live.test.ts` | 2 (all) | 2 (all) | 2 (all) | Opt-in: `describe.skipIf(!process.env.CCC_LIVE_SENTINEL_TEST)` (line 30). The cases run the real `claude -p` (lines 1-7). No CI job sets the variable. | No CI or VM run found |
| `tests/wp1/authority-manifest.test.ts` | 1 | 1 | 1 | `it.skipIf(binary === null)` (line 852). Regenerating the manifest needs the pinned claude binary (`pinnedBinary`, line 53): `CLAUDE_BINARY`, or the pinned version under `~/.local/share/claude/versions/` or `~/.local/bin`, with the recorded size and digest. The comment says "Never run by CI: CI has no Claude binary" (line 856). | No CI or VM run found; a maintainer's regeneration run |
| `tests/wp1/codex-realm-isolation.test.ts` | - | 1 | 1 | Windows only: `it.runIf(IS_WIN)` (line 225), a junction to a volume-GUID path. HOST QUARANTINE. | Windows |
| `tests/wp1/managed-launch.test.ts` | 4 | 3 | 3 | `it.skipIf(process.platform === 'win32')` on 4 cases (lines 1944, 2017, 2385, 2767: git pointer short reads, a torn pointer, the walk to the git root, a FIFO). `it.runIf(process.platform === 'win32')` on 3 cases (lines 2032, 2398, 2416: a trailing dot or space, the loopback admin share, an extended-length path). The admin-share case also skips where the share is unreadable (line 2412). It ran on Windows: Windows' count is 4. | Each set runs on the other OS or OSes |

## Quarantine

Quarantine here means HOST QUARANTINE: a file whose header carries that marker is never run on the owner's workstation; it runs in CI and on the VM. The marker is not a skip condition. `vitest.config.ts` collects `tests/unit`, `tests/integration` and `tests/wp1` and excludes only `*.native.test.*`, so the Test job collects all 13 marked test files on every OS. This record covers CI only; no VM run is recorded here.

| File | Test job (Windows / macOS / Linux) | Also runs in |
|---|---|---|
| `tests/integration/codex-cli-compat.test.ts` | collected, skipped on all three (no `codex` on PATH) | the codex-conformance job, 5 passed on each of the six legs |
| `tests/integration/codex-real-cli-conformance.test.ts` | collected, skipped on all three (no `CCC_CODEX_CONFORMANCE_BIN`) | the codex-conformance job, 8 passed on each of the six legs |
| `tests/unit/claude-headless-real-argv.test.ts` | 1 passed / 1 / 1 | |
| `tests/unit/main/account-folders-links-real.test.ts` | 4 passed / 4 / 4 | |
| `tests/unit/main/codex-realm-skills-links.test.ts` | 6 passed / 6 / 6 | |
| `tests/unit/main/codex-realm-skills-race-links.test.ts` | 4 passed / 4 / 4 | |
| `tests/unit/main/help-workspace-rebuild-links.test.ts` | 3 passed / 3 / 3 | |
| `tests/unit/main/owner-only-folders-real.test.ts` | 4 passed / skipped / skipped (Windows only) | |
| `tests/unit/providers/codex/hook-wrapper-start-folder.test.ts` | 2 passed / skipped / skipped (Windows only) | |
| `tests/wp1/codex-realm-isolation.test.ts` | 8 passed / 7 passed, 1 skipped / 7 passed, 1 skipped (the Windows-only case) | |
| `tests/wp1/fake-cli.test.ts` | 26 passed / 26 / 26 | |
| `tests/wp1/registry-fs-port.test.ts` | 13 passed / 13 / 13 | |
| `tests/wp1/review-profile-home.test.ts` | 5 passed / 5 / 5 | |

`tests/wp1/legacy-codex-ledger.json` also contains the marker, in its notes on these files; it is a data file, not a test.

## Unexplained or to decide

- Nothing the counts leave unexplained. On every OS, every file's skip and todo count matches a condition at fcfd2ae6, and the per-OS totals match the log.
- Cases that run in no CI job, with no VM run found:
  - `tests/unit/main/installer-nsis-behaviour.test.ts`, 13 cases. No runner has makensis. They run only on a Windows machine that has it. The file is not marked HOST QUARANTINE.
  - `tests/integration/hooks/real-claude.test.ts`, 1 case, and `tests/unit/sentinel-live.test.ts`, 2 cases: opt-in, they run the real `claude` and spend tokens.
  - `tests/unit/console-bleed-verification.test.ts`, 1 case: a manual placeholder for `scripts/verify-console-bleed.mjs`. No run of that script is recorded.
  - `tests/wp1/authority-manifest.test.ts`, 1 case: manifest regeneration against the pinned claude binary.
  - `tests/unit/scripts/codex-hook-forwarder.test.ts`, the proxy case: it needs a Node with environment proxies, and CI runs Node 20.
  - The fish cases of `tests/unit/main/ssh-end-remote-shell-compat.test.ts` (3) and `tests/unit/main/container-entry-shell-compat.test.ts` (1), and the busybox cases of the second file (2). As the counts read, no runner has fish or busybox. The second file names the live SSH matrix as their cover (line 15), and that matrix is a manual gate.
- Read from the counts, not the log:
  - the split of the two shell-compatibility files;
  - in `tests/unit/main/container-entry-shell-compat.test.ts` on Windows, which startup-file case skipped (line 134 or 147);
  - which of `codex-hook-forwarder.test.ts`'s two conditional cases skipped on Windows.

  The default reporter does not name skipped cases. To decide: should the candidate run publish a per-case report (a JSON or JUnit reporter, uploaded as the run's artifact), so this record is read rather than inferred?
- The 2 todo cases, `tests/unit/renderer/commandbar-menus.test.tsx`:
  - line 666: "Collapse band", which the band menu does not offer yet;
  - line 812: "Move left/right on a Core tool", which `CoreToolMenu` draws only when the bar passes `onMove`.

  Both are marked D9 optional and test nothing that exists. To decide: build them, or drop the todos.
- Beta's side of the merge (6a07c3fb) was not read. If it changed any file above, that file's lines may differ in the tree CI ran.

## Flaky

No test failed and then passed on retry in this run, so this run records no flaky test. Retry is not configured:

- `vitest.config.ts` and `vitest.native.config.ts` set no `retry`.
- In `ci.yml`, neither `npx vitest run` nor `npm run test:unit:native` (`scripts/run-native-tests.mjs`) passes `--retry`.

The three Test logs hold no `(retry xN)` marker and no failed test, and every codex-conformance leg passed. Flakiness seen elsewhere is not recorded here.
