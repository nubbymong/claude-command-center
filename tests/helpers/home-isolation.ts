// Tests never act on a real home.
//
// The FIRST setup file of every vitest run (setupFiles[0] in vitest.config.ts and
// vitest.native.config.ts). It is a setupFiles entry rather than an import at the
// top of tests/unit/setup.ts because vitest hoists the vi.mock() calls in that file
// above its imports, and an import-sorting edit could move it; the setupFiles order
// is the one ordering vitest guarantees.
//
// It points the home variables (HOME_VARS in home-guard-core.mjs, and HOMEDRIVE/HOMEPATH
// on Windows) at a fresh folder per worker, re-asserts them
// before every test, and installs the guard in home-guard-core.mjs: an fs mutation
// or a spawn that would act on a real home throws TEST_ISOLATION_VIOLATION, and a
// refusal the code under test catches still fails the test in afterEach.
//
// Not loaded by vitest.live.config.ts (the live SSH pack runs real ssh with the
// user's real keys) or by Playwright.
import * as path from 'path'
import { afterAll, afterEach, beforeEach } from 'vitest'
// Redirects TEMP/TMP/TMPDIR to the per-worker root; its parent is the original temp folder.
import { TEST_TMP_ROOT } from './test-tmp'
import { assertNoViolations, installHomeGuard, reassertHomeEnv } from './home-guard-core.mjs'

installHomeGuard({ entry: 'vitest', isolate: true, extraTmpRoots: [path.dirname(TEST_TMP_ROOT)] })

beforeEach(() => {
  reassertHomeEnv()
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
