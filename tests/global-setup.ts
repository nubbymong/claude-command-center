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
    // A drive-relative `/mock` resolves onto whichever drive is current, so a
    // suite run from C: scattered to C:\mock and one from F: to F:\mock. Sweep
    // the roots that can be hit: the cwd drive, the temp drive, and C:.
    const drives = new Set(
      [process.cwd(), os.tmpdir(), 'C:\\'].map((p) => path.parse(path.resolve(p)).root),
    )
    for (const root of drives) {
      try {
        const mock = path.join(root, 'mock')
        if (fs.existsSync(mock)) fs.rmSync(mock, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}
