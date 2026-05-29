import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Resolve ~ to the user's home directory.
 * On Windows, ~ is not resolved by the OS -- only by shells.
 *
 * If `cwd` resolves to a path that does not exist on disk, fall back to the
 * user's home directory rather than letting the PTY spawn fail with
 * "[Process exited with code 1]". This keeps demo/seeded sessions usable
 * when the configured project directory is missing on the current machine.
 */
export function resolveCwd(cwd: string | undefined): string {
  const home = os.homedir()
  if (!cwd || cwd === '.') return home
  if (cwd === '~') return home
  let resolved: string
  if (cwd.startsWith('~/') || cwd.startsWith('~\\')) {
    resolved = path.join(home, cwd.slice(2))
  } else {
    resolved = path.resolve(cwd)
  }
  try {
    const stat = fs.statSync(resolved)
    if (!stat.isDirectory()) return home
  } catch {
    return home
  }
  return resolved
}
