// One disposable temp root per test worker (#559).
//
// Redirecting TEMP/TMP/TMPDIR here means every `fs.mkdtempSync(os.tmpdir(),
// 'ccc-...')` fixture across the suite lands *inside* this root instead of
// littering the real %TEMP% (a full run was leaking ~88 GB of `ccc-*` dirs that
// nothing ever cleaned up). MOCK_RESOURCES / MOCK_USERDATA give the electron
// mocks a real, writable path under the same root instead of the drive-relative
// literal '/mock/resources' — which on Windows resolved to `<drive>:\mock` and
// wrote real files (a conductor-secret.json) to the drive root.
//
// The root is created once per worker (keyed through the environment so every
// test file in the worker shares it) and removed on process exit;
// tests/global-setup.ts sweeps any orphan left by a killed worker.
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

const KEY = 'CCC_TEST_TMP_ROOT'
const existing = process.env[KEY]

export const TEST_TMP_ROOT =
  existing && fs.existsSync(existing) ? existing : fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-vitest-'))

// First importer in this worker owns setup: pin the root in the env, redirect
// the process temp dir, and register a single exit-time cleanup. Subsequent
// files reuse it (no duplicate 'exit' listeners -> no MaxListeners warning).
if (!existing) {
  process.env[KEY] = TEST_TMP_ROOT
  process.env.TMPDIR = TEST_TMP_ROOT
  process.env.TEMP = TEST_TMP_ROOT
  process.env.TMP = TEST_TMP_ROOT
  process.once('exit', () => {
    try {
      fs.rmSync(TEST_TMP_ROOT, { recursive: true, force: true })
    } catch {
      /* best-effort; global-setup teardown is the backstop */
    }
  })
}

export const MOCK_RESOURCES = path.join(TEST_TMP_ROOT, 'resources')
export const MOCK_USERDATA = path.join(TEST_TMP_ROOT, 'userData')
