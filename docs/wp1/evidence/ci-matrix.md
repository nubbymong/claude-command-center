# CI matrix: per-OS evidence

This file is evidence for WP1.30 (`docs/wp1/evidence/ci-matrix.md`), and the CI half of rows 59 and 60 of the WP2 completion plan (P4.8: Linux in the test matrix, real-CLI conformance; OD20 D5 and D7, WP1.71).

WP1.30 says the Windows ACL and Unix mode tests must run on each OS runner, so its evidence is the CI matrix run, not a local run. The real-CLI conformance runs are also row 2's detection evidence per OS (P4.10).

**Status: not recorded yet.** The workflow below landed in PR 4 (P4.8). No run of it is recorded here. The first run on the PR 4 branch with the `ci-run` label fills the results tables, then this status line changes. WP1.30 stays `planned` in the traceability manifest until a run is recorded here with its digest.

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
- Linux is non-blocking (`continue-on-error`) only until its first green run. The commit that records that run here removes the `continue-on-error` line, and from then on a Linux failure fails the run. PR 4's package gate 7 needs Windows, macOS and Linux green at the final head.
- The suite last ran on Linux in `release.yml` (`build-linux`, release run 35534211954, beta of 2026-09-20: 898 test files passed, 3 skipped; 11,164 tests). The WP2 stack's tests had not run on Linux before P4.8.

### The real-CLI conformance job (`Codex CLI <version class> (<os>)`)

- Runners: `windows-2025`, `macos-latest`, `ubuntu-latest`.
- Versions:
  - every run checks the minimum and the pinned version, read from `src/main/providers/codex/cli-contract.ts` (`CODEX_MIN_SUPPORTED_VERSION` 0.153.4, `CODEX_PINNED_CLI_VERSION` 0.155.1);
  - the release-candidate version is checked only when the workflow is dispatched with `codex_rc_version` (release level, D7). PR runs have no such input.
- Each version is installed with `npm install --global --prefix <its own folder>` from the published `@openai/codex` package. The job holds no secrets. Every run of the CLI gets a fresh, empty `CODEX_HOME`; there is no sign-in and no request that needs the network.
- Checks (`tests/integration/codex-real-cli-conformance.test.ts`, P3.1's no-sign-in checks):
  1. detection: the app's discovery proves the installed CLI through its real runner (on Windows the npm shim through cmd.exe), with its version and class; the app's own PATH resolution finds the same file;
  2. every flag of the command lines the app runs is listed by the real help of the subcommand it names;
  3. the model list (`codex debug models --bundled`) through the app's own reader is covered by `resources/model-registry.json`, and for the minimum and pinned versions it equals the recorded list;
  4. `codex features list` names every feature the analysis run turns off;
  5. help: P3.1's captures are made again, uploaded as the run's artifact, and compared with the normalised fixtures in `tests/fixtures/codex/cli/<version>/help/`. The comparison is reported, not asserted, until the captures of each OS are reviewed; then `CCC_CODEX_HELP_ASSERT` turns to `1` in the workflow.
- Then the flag-drift suite (`tests/integration/codex-cli-compat.test.ts`) runs against the same install. A step first proves `codex --version` on PATH prints the installed version, so that suite cannot pass by skipping.
- The pure comparisons are proven to fail on a deliberately wrong fixture on every run of the suite (`tests/integration/codex-conformance-lib.test.ts`). Each check is also shown red once in CI: a dispatch with `conformance_prove_red` runs every check against a deliberately wrong expectation, and the job must go red with each check named.

## Results

### Test matrix

| Run | Commit | Windows | macOS | Linux | WP1.30 files on each OS |
|---|---|---|---|---|---|
| (not recorded yet) | | | | | |

### Real-CLI conformance

| Run | Commit | OS | Version class | Version | Detection | Flags | Model list | Features | Help against the fixtures | Flag-drift suite |
|---|---|---|---|---|---|---|---|---|---|---|
| (not recorded yet) | | | | | | | | | | |

### Shown red once (dispatch with `conformance_prove_red`)

| Run | Commit | Result | Checks that failed, as they must |
|---|---|---|---|
| (not recorded yet) | | | |

### Help captures reviewed

For each OS, the help comparison is reviewed from the run's artifact (`codex-conformance-<os>-<version class>`: `help/*.txt`, `help-compare.md`, `report.md`) before it is asserted. The differences found, and whether each is an OS difference or a fixture to refresh, are recorded here.

| OS | Run | Version | Captures that differ | Decision |
|---|---|---|---|---|
| (not recorded yet) | | | | |
