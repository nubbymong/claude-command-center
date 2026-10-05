// Tests never act on a real home.
//
// The FIRST setup file of every vitest run (setupFiles[0] in vitest.config.ts and
// vitest.native.config.ts). It is a setupFiles entry rather than an import at the
// top of tests/unit/setup.ts because vitest hoists the vi.mock() calls in that file
// above its imports, and an import-sorting edit could move it; the setupFiles order
// is the one ordering vitest guarantees.
//
// It points the home variables (HOME_VARS in home-guard-core.mjs; HOMEDRIVE/HOMEPATH
// on Windows, the XDG folders elsewhere) at a fresh folder per worker, re-asserts
// them before every test, and installs the guard in home-guard-core.mjs. That file
// lists what the guard covers and what it does not. A refusal the code under test
// catches still fails the test in afterEach. Installing fails loudly if os.homedir()
// is not inside the isolated folder afterwards (a worker THREAD keeps its own copy
// of the environment: vitest.config.ts pins pool 'forks', and the native config
// already runs in forks).
//
// Not loaded by vitest.live.config.ts (the live SSH pack runs real ssh with the
// user's real keys) or by Playwright.
import * as fs from 'fs'
import * as path from 'path'
import { afterAll, afterEach, beforeEach } from 'vitest'
// Redirects TEMP/TMP/TMPDIR to the per-worker root; its parent is the original temp folder.
import { TEST_TMP_ROOT } from './test-tmp'
import { assertNoViolations, installHomeGuard, reassertHomeEnv } from './home-guard-core.mjs'

installHomeGuard({ entry: 'vitest', isolate: true, extraTmpRoots: [path.dirname(TEST_TMP_ROOT)] })

// The app's data folder (src/main/data-paths.ts) is the installed app's, under the real
// LOCALAPPDATA, unless CCC_E2E_DATA_DIR names one: pin it once per worker to a folder
// under the worker's temp root, so a test that keeps the real logger writes there. A
// test of data-paths itself deletes it locally (tests/unit/main/data-paths-dev.test.ts).
export const TEST_DATA_DIR_ENV = 'CCC_E2E_DATA_DIR'
const TEST_DATA_DIR = path.join(TEST_TMP_ROOT, 'app-data')
fs.mkdirSync(TEST_DATA_DIR, { recursive: true })
if (!process.env[TEST_DATA_DIR_ENV]) process.env[TEST_DATA_DIR_ENV] = TEST_DATA_DIR

beforeEach(() => {
  reassertHomeEnv()
  if (!process.env[TEST_DATA_DIR_ENV]) process.env[TEST_DATA_DIR_ENV] = TEST_DATA_DIR
})

afterEach(() => {
  assertNoViolations('the test')
})

afterAll(() => {
  assertNoViolations('a suite hook')
})

export {
  VIOLATION_CODE,
  isolatedRoot,
  isRealHomePath,
  originalHomeEnv,
  realHomeRoots,
} from './home-guard-core.mjs'
