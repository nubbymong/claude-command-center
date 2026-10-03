# CI matrix: per-OS evidence

This file is evidence for WP1.30 (`docs/wp1/evidence/ci-matrix.md`), and the CI half of rows 59 and 60 of the WP2 completion plan (P4.8: Linux in the test matrix, real-CLI conformance; OD20 D5 and D7, WP1.71).

WP1.30 says the Windows ACL and Unix mode tests must run on each OS runner, so its evidence is the CI matrix run, not a local run. The real-CLI conformance runs are also row 2's detection evidence per OS (P4.10).

**Status: the first green run of the whole workflow, CI run 37134624406, is recorded below (the test matrix and the six conformance legs), with the help captures reviewed per OS; the prove-red dispatch is not recorded yet.** The workflow below landed in PR 4 (P4.8). WP1.30 stays `planned` in the traceability manifest until a run at the binding's head is recorded here with its digest (the candidate declaration, made at release).

## What runs

Workflow: `.github/workflows/ci.yml`. On a pull request both jobs need the `ci-run` label; every push to `main` runs them.

### The test matrix (`Test (<os>)`)

- Runners: `windows-2025`, `macos-latest`, `ubuntu-latest`.
- Steps per runner:
  - `npm ci --ignore-scripts`, then the Electron binary;
  - on macOS and Linux, node-pty and better-sqlite3 rebuilt from source (Windows uses the shipped N-API prebuilds);
  - `npm run typecheck`;
  - the WP1 ledger's bound commit fetched (`scripts/wp1/fetch-ledger-commit.mjs`);
  - `npx vitest run`, the whole suite, which includes WP1.30's tests: `tests/wp1/realm-paths.test.ts`, `tests/wp1/codex-realm-folders.test.ts` and `tests/wp1/codex-realm-isolation.test.ts`;
  - `npm run test:unit:native` (better-sqlite3 under Electron-as-Node);
  - `npm run build`.
- Linux was non-blocking (`continue-on-error` on the job) until its first green run, CI run 37134624406 (below). The commit that recorded that run removed the line, so a Linux failure now fails the run like any other. PR 4's package gate 7 needs Windows, macOS and Linux green at the final head.
- The suite last ran on Linux in `release.yml` (`build-linux`, release run 35534211954, beta of 2026-09-20: 898 test files passed, 3 skipped; 11,164 tests). The WP2 stack's tests had not run on Linux before P4.8.

### The real-CLI conformance job (`Codex CLI <version class> (<os>)`)

- Runners: `windows-2025`, `macos-latest`, `ubuntu-latest`.
- Versions:
  - every run checks the minimum and the pinned version, read from `src/main/providers/codex/cli-contract.ts` (`CODEX_MIN_SUPPORTED_VERSION` 0.153.4, `CODEX_PINNED_CLI_VERSION` 0.155.1);
  - the release-candidate version is checked only when the workflow is dispatched with `codex_rc_version` (release level, D7). PR runs have no such input.
- Each version is installed with `npm install --global --prefix <its own folder> --ignore-scripts` from the published `@openai/codex` package, into an npm cache of its own (not the one the job saves). The package and its platform packages declare no install scripts (0.153.4 and 0.155.1, read from the registry on 2026-10-03), so none is needed; a release whose CLI needed one would fail the job, not pass it. The checkout keeps no token on disk (`persist-credentials: false`), and the job holds no secrets.
- Every run of the CLI gets a fresh, empty `CODEX_HOME`, and there is no sign-in and no request that needs the network:
  - the suite makes one per run: its own runs, the app's version check (discovery's version home) and the model list (its scratch home);
  - the `codex --version` PATH check and the flag-drift suite each get one made just before them (`codex-conformance-ci.mjs homes`);
  - a step records the runner's own `~/.codex` (absent, or every folder and every other entry's path, size and modified time) before the CLI is installed, and the job's last step fails if it changed, so a run that used it cannot pass unseen. If the record step did not run, the last step fails saying the record is missing, not that the home was used. The picture and the comparison (`tests/integration/codex-own-home.mjs`) are proven to fail on each change on every run of the suite (`tests/integration/codex-own-home.test.ts`).
- Checks (`tests/integration/codex-real-cli-conformance.test.ts`, P3.1's no-sign-in checks):
  1. detection: the app's discovery proves the installed CLI through its real runner (on Windows the npm shim through cmd.exe), with its version and class; the app's own PATH resolution finds the same file;
  2. every flag of the command lines the app runs is defined (on an option line of its own, not only mentioned in prose) by the real help of the subcommand it names, each such help exits 0, and its `Usage:` line names that subcommand: a dropped subcommand that exits 0 with the top-level help (as 0.155.1's `mcp-server --help` does) fails, which matters for `logout` and `app-server`, whose command lines pass no flag;
  3. the model list (`codex debug models --bundled`) through the app's own reader is covered by `resources/model-registry.json`, and for the minimum and pinned versions it equals the recorded list. It is a case of its own, so a red detection never hides it, and coverage and the recorded list are two soft checks, both reported in one run;
  4. `codex features list` names every feature the analysis run turns off;
  5. help: P3.1's captures are made again, uploaded as the run's artifact, and compared with the normalised fixtures in `tests/fixtures/codex/cli/<version>/help/` as the run's OS reads them. The fixtures were captured on Windows; the differences reviewed for macOS and Linux (below) are accepted by name and nothing else (`REVIEWED_HELP_DIFFERENCES` in `tests/integration/codex-conformance-lib.ts`): each names its OS, versions, captures and the one fixture line it changes, and one whose line the fixture no longer holds exactly once fails. The run's own Codex home and temporary folder are compared as names (`<RUN_HOME>`, `<RUN_TMPDIR>`), since the Linux stderr line names them. The comparison is reported, not asserted, until `CCC_CODEX_HELP_ASSERT` turns to `1` in the workflow.
- Then the flag-drift suite (`tests/integration/codex-cli-compat.test.ts`) runs against the same install. A step first proves `codex --version` on PATH prints the installed version, so that suite cannot pass by skipping.
- The pure comparisons are proven to fail on a deliberately wrong fixture on every run of the suite (`tests/integration/codex-conformance-lib.test.ts`).
- Each check of the suite is also shown red once in CI: a dispatch with `conformance_prove_red` (and no release candidate) runs it against a deliberately wrong expectation. Every leg must go red naming:
  - detection, both cases (a wrong version);
  - flags (a flag no help defines, and for each command line a subcommand its help does not name);
  - the model list, both soft checks (a registry without the first listed model; the recorded list with an extra id);
  - features (a feature no list names);
  - help (each fixture with its last line dropped), asserted in that run.
- Not shown red by that dispatch: the PATH check step, the flag-drift suite (`codex-cli-compat.test.ts`, which predates P4.8 and has no prove-red input), the runner's own home check (its comparison is shown red by `codex-own-home.test.ts` instead), and an rc leg's help (no fixture exists for a release candidate).

## Results

### Test matrix

| Run | Commit | Windows | macOS | Linux | WP1.30 files on each OS |
|---|---|---|---|---|---|
| CI run 37134624406 (`pull_request`, attempt 1, 2026-10-03) | fcfd2ae60b9174a15768c443056b068f4a9d61a3, run as GitHub's merge with beta (6a07c3fb74a255266b04234482323760bb9a6da1) | Green. Typecheck; vitest 1,189 files (1,184 passed, 5 skipped), 17,391 tests (17,313 passed, 76 skipped, 2 todo); native 14 files, 225 tests passed; build | Green. Typecheck; vitest 1,189 files (1,183 passed, 6 skipped), 17,391 tests (17,315 passed, 74 skipped, 2 todo); native 14 files, 217 passed, 8 skipped; build | Green, the WP2 stack's first Linux run. Typecheck; vitest 1,189 files (1,182 passed, 7 skipped), 17,391 tests (17,307 passed, 82 skipped, 2 todo); native 14 files, 217 passed, 8 skipped (the first `test:unit:native` run on Linux); build | Each passed on all three: `realm-paths.test.ts` 13 tests, `codex-realm-folders.test.ts` 118, `codex-realm-isolation.test.ts` 8 (its one Windows-only case, a junction to a volume-GUID path, skipped on macOS and Linux) |

How the run was read: `continue-on-error` on a job hides a red job behind a green run, so the Linux job was read step by step (`gh api .../actions/jobs/111236523243`): every step from the checkout to the build succeeded, and the vitest and native summaries above are from its log. The run's overall conclusion is `failure` only because of the Desktop test gate job, which waits for the owner's attestation (#309); every Test job, every conformance leg, Changelog in sync and the SSH multi-session smoke passed. The first run on the branch, at 69c98042, was red on macOS and Linux in tests only (fixed in b76e9f6c and 1eba3623).

### Real-CLI conformance

| Run | Commit | OS | Version class | Version | Detection | Flags | Model list | Features | Help against the fixtures | Flag-drift suite | Own home untouched |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CI run 37134624406 | fcfd2ae6 | Windows (`windows-2025`, win32-x64; job 111236523268) | minimum | 0.153.4 | Both cases found, version 0.153.4, supported; PATH resolution finds the install (`codex.cmd`) | Every flag defined on an option line of its subcommand's own help; each help exits 0 and its Usage line names the subcommand | equal to the recorded list (6 ids, gpt-5.2 among them); covered by the registry | 135 listed; the 12 turned off all named | 15 of 15 the same (reported, not asserted, in this run) | 5 passed, none skipped | Yes: absent before the install and after the last run |
| CI run 37134624406 | fcfd2ae6 | Windows (`windows-2025`, win32-x64; job 111236523322) | pinned | 0.155.1 | Both cases found, version 0.155.1, supported; PATH resolution finds the install (`codex.cmd`) | Every flag defined on an option line of its subcommand's own help; each help exits 0 and its Usage line names the subcommand | equal to the recorded list (5 ids, no gpt-5.2); covered by the registry | 141 listed; the 12 turned off all named | 15 of 15 the same (reported, not asserted, in this run) | 5 passed, none skipped | Yes: absent before the install and after the last run |
| CI run 37134624406 | fcfd2ae6 | macOS (`macos-latest`, darwin-arm64; job 111236523255) | minimum | 0.153.4 | Both cases found, version 0.153.4, supported; PATH resolution finds the install (`codex.js` (the npm bin link)) | Every flag defined on an option line of its subcommand's own help; each help exits 0 and its Usage line names the subcommand | equal to the recorded list (6 ids); covered | 135 listed; the 12 turned off all named | 13 the same; 2 differ (`features-list`, `sandbox-help`), reviewed below (reported, not asserted, in this run) | 5 passed, none skipped | Yes: absent before the install and after the last run |
| CI run 37134624406 | fcfd2ae6 | macOS (`macos-latest`, darwin-arm64; job 111236523295) | pinned | 0.155.1 | Both cases found, version 0.155.1, supported; PATH resolution finds the install (`codex.js` (the npm bin link)) | Every flag defined on an option line of its subcommand's own help; each help exits 0 and its Usage line names the subcommand | equal to the recorded list (5 ids); covered | 141 listed; the 12 turned off all named | 13 the same; 2 differ (`features-list`, `sandbox-help`), reviewed below (reported, not asserted, in this run) | 5 passed, none skipped | Yes: absent before the install and after the last run |
| CI run 37134624406 | fcfd2ae6 | Linux (`ubuntu-latest`, linux-x64; job 111236523262) | minimum | 0.153.4 | Both cases found, version 0.153.4, supported; PATH resolution finds the install (`codex.js` (the npm bin link)) | Every flag defined on an option line of its subcommand's own help; each help exits 0 and its Usage line names the subcommand | equal to the recorded list (6 ids); covered | 135 listed; the 12 turned off all named | 15 differ, every one by the stderr line reviewed below; `help`, `features-list` and `sandbox-help` also in stdout (reported, not asserted, in this run) | 5 passed, none skipped | Yes: absent before the install and after the last run |
| CI run 37134624406 | fcfd2ae6 | Linux (`ubuntu-latest`, linux-x64; job 111236523240) | pinned | 0.155.1 | Both cases found, version 0.155.1, supported; PATH resolution finds the install (`codex.js` (the npm bin link)) | Every flag defined on an option line of its subcommand's own help; each help exits 0 and its Usage line names the subcommand | equal to the recorded list (5 ids); covered | 141 listed; the 12 turned off all named | 15 differ, every one by the stderr line reviewed below; `help`, `mcp-server-help`, `features-list` and `sandbox-help` also in stdout (reported, not asserted, in this run) | 5 passed, none skipped | Yes: absent before the install and after the last run |

Each leg ran its `codex --version` PATH check first (it printed exactly `codex-cli <version>`), then the suite (8 passed; the one skipped case is the placeholder for a run with no CLI given). The runs are also row 2's detection evidence per OS (P4.10). The help captures, the comparison and the run report are the run's artifacts `codex-conformance-<os>-<version class>` (kept until 2026-11-02).

### Shown red once (dispatch with `conformance_prove_red`)

| Run | Commit | Result | Checks that failed, as they must |
|---|---|---|---|
| (not recorded yet) | | | |

### Help captures reviewed

For each OS, the help comparison is reviewed from the run's artifact (`codex-conformance-<os>-<version class>`: `help/*.txt`, `help-compare.md`, `report.md`) before it is asserted. The differences found, and whether each is an OS difference or a fixture to refresh, are recorded here.

| OS | Run | Version | Captures that differ | Decision |
|---|---|---|---|---|
| Windows | CI run 37134624406 | 0.153.4, 0.155.1 | None | Nothing to decide: the fixtures were captured on Windows (the test VM, P3.1) and the CI captures match them byte for byte |
| macOS | CI run 37134624406 | 0.153.4, 0.155.1 | `features-list`: `secret_auth_storage` reads `false` (Windows: `true`). `sandbox-help`: the command argument runs "under seatbelt" (Windows: "under Windows restricted token sandbox"), and two options follow `--include-managed-config` that Windows does not have, `--allow-unix-socket <ALLOW_UNIX_SOCKETS>` and `--log-denials` (8 lines with their blank lines) | OS differences: a feature's default on this platform, and the platform's own sandbox. Neither touches a flag the app passes (the flags check passed). No fixture to refresh |
| Linux | CI run 37134624406 | 0.153.4, 0.155.1 | `help` (and on 0.155.1 `mcp-server-help`, which prints the top-level help): no `app` line ("Launch the Desktop app (opens the app installer if missing)"). `features-list`: `secret_auth_storage` reads `false`. `sandbox-help`: "under the Linux sandbox". Every capture's stderr: one line, `WARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir "<RUN_TMPDIR>" (codex_home: AbsolutePathBuf("<RUN_HOME>"))`, with this run's temporary folder and Codex home in place of the two names | OS differences: Codex offers no Desktop app on Linux (the app runs `app-server`, never `app`), the feature default and the platform's sandbox. The stderr line is the run's set-up, not the help: on Linux Codex will not put its PATH helper binaries in a home under the temporary folder, and the suite makes its fresh homes there; exit codes and stdout are unaffected, and the app's discovery and model list, which also run in temporary homes, passed. No fixture to refresh |

Every difference above was read in the captures themselves (`help/<name>.txt` against the fixture, line by line, not only the first difference `help-compare.md` names). None is a change in a command line the app runs, and none is a fixture to refresh. The comparison now accepts exactly these differences on their OS and nothing else; applied to this run's 90 captures (six legs, 15 each), every one compares the same, and with prove-red's fixture (its last stdout line dropped) every one is red. `codex-conformance-lib.test.ts` holds the same on captures made from the fixtures by hand, and shows any other difference, one on another OS, a reviewed one missing or a warning naming another home still fails.
