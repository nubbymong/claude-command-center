import * as os from 'os'
import * as path from 'path'

/**
 * Resolve ~ to the user's home directory.
 * On Windows, ~ is not resolved by the OS — only by shells.
 */
export function resolveCwd(cwd: string | undefined): string {
  if (!cwd || cwd === '.') return os.homedir()
  if (cwd === '~') return os.homedir()
  if (cwd.startsWith('~/') || cwd.startsWith('~\\')) {
    return path.join(os.homedir(), cwd.slice(2))
  }
  // Resolve any relative paths to absolute (prevents using Electron's process.cwd())
  return path.resolve(cwd)
}
