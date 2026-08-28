// Vitest global teardown (#559): runs once in the main process after the whole
// run. Backstop that removes any per-worker `ccc-vitest-*` temp roots a killed
// worker left behind, plus a stray drive-root `\mock` from any hardcoded mock
// path, so a test run never leaves litter on the drive.
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

export default function () {
  return () => {
    try {
      const tmp = os.tmpdir()
      for (const entry of fs.readdirSync(tmp)) {
        if (entry.startsWith('ccc-vitest-')) {
          try {
            fs.rmSync(path.join(tmp, entry), { recursive: true, force: true })
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const mock = path.resolve('/mock')
      if (fs.existsSync(mock)) fs.rmSync(mock, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}
