// A test's own data folder, for a test that keeps the REAL debug-logger.
//
// The real logger appends to <data folder>/debug/app.log. getDataDirectory()
// (src/main/data-paths.ts) reads the installed app's folder from the registry, and
// wherever the app is installed that folder is inside the real LOCALAPPDATA, where the
// home guard (tests/helpers/home-isolation.ts) refuses the write. This pins the folder
// to a fresh one under the test's temp root through CCC_E2E_DATA_DIR, the override
// data-paths checks before the registry (tests/unit/main/live-harness-data-dir.test.ts
// pins that mechanism), so the logger keeps its log inside the test's own folder.
//
// Call it at the top of the test file, through vi.hoisted, so the variable is set
// before any module resolves the folder (data-paths keeps the first answer):
//
//   const TEST_DATA = await vi.hoisted(async () =>
//     (await import('../../helpers/test-data-dir')).useTestDataDirectory())
//
// The variable goes back to what it was in afterAll of the suite that called it. The
// folder is left in place: it is under the per-worker temp root, which is removed when
// the worker exits, and the logger may still hold its log open until then.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterAll } from 'vitest'

export const DATA_DIR_ENV = 'CCC_E2E_DATA_DIR'

/** Point the data folder at a fresh folder under the test temp root; restore() puts the variable back. */
export function pinTestDataDirectory(): { dir: string; restore: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-test-data-'))
  const previous = process.env[DATA_DIR_ENV]
  process.env[DATA_DIR_ENV] = dir
  return {
    dir,
    restore: () => {
      if (previous === undefined) delete process.env[DATA_DIR_ENV]
      else process.env[DATA_DIR_ENV] = previous
    },
  }
}

/** pinTestDataDirectory() for the calling suite, restored in its afterAll. Returns the folder. */
export function useTestDataDirectory(): string {
  const pin = pinTestDataDirectory()
  afterAll(pin.restore)
  return pin.dir
}
