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
  // Pass absolute paths through; resolve relative paths against process.cwd().
  // The empty / '.' / '~' cases above are intentionally redirected to homedir()
  // so callers passing those values don't accidentally land in Electron's
  // main-process cwd (the resources directory in packaged builds).
  return path.resolve(cwd)
}
