## 2026-08-28 -- #559: contain test temp in a disposable per-worker root

A full `npx vitest run` was leaking throwaway temp on every run: ~129 test files
`fs.mkdtempSync(join(os.tmpdir(),'ccc-...'))` with no teardown (observed ~88 GB of
`ccc-*` in %TEMP% on a dev box), and the global `getResourcesDirectory` mock
returned the drive-relative literal `/mock/resources`, so tests writing real fs
scattered files to `<drive>:\mock\resources` (a real `conductor-secret.json`
turned up at `C:\mock\...`). Dev/SDLC hygiene only -- not shipped-app behaviour
(the one runtime temp path, codex-review, already cleans up via try/finally, #487).

Fix (test-side, contained):
- `tests/helpers/test-tmp.ts` -- creates ONE disposable root per worker under the
  real `os.tmpdir()`, keyed through `CCC_TEST_TMP_ROOT` so every test file in the
  worker shares it (single `exit` cleanup, no MaxListeners churn), and redirects
  `TEMP`/`TMP`/`TMPDIR` to it so every `mkdtemp(os.tmpdir(),...)` lands inside.
  Exports `MOCK_RESOURCES`/`MOCK_USERDATA` under the root.
- `tests/unit/setup.ts` -- the global `getResourcesDirectory` and `app.getPath`
  mocks now return those temp paths instead of `/mock/...`.
- `tests/global-setup.ts` -- vitest teardown backstop: sweeps orphan
  `ccc-vitest-*` roots (killed worker) and a stray drive-root `\mock`.

`config-manager.test.ts` keeps its local `/mock/resources` mock: it fully mocks
`fs`, so it never writes to disk -- inert, and its exact-path assertion stays
valid. Setup files run before a test file's `vi.mock('fs')` applies, so the helper
loads with real `fs`.

Verified: full suite 8822 passed (unchanged); a run now adds 0 net `ccc-*` to the
real temp, leaves 0 `ccc-vitest-*`, and writes no `\mock`.
