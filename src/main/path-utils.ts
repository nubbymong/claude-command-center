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

/**
 * SECURITY (adversarial review, #188): true when `cwd` IS the user's home
 * directory or an ANCESTOR of it. codex_review must never register or run against
 * such a root — mode:'paths' containment would otherwise allow ~/.ssh, ~/.claude,
 * ~/.aws (they resolve inside the root with no '..').
 *
 * A plain `cwd === os.homedir()` string compare is not enough: resolveCwd() falls
 * back to home for '.', empty and stale paths, but a *configured* path that merely
 * POINTS at home evades a string compare — a case-variant (`c:\users\me` vs
 * `C:\Users\me`) on case-insensitive Windows, the `\\?\` extended-length form, or a
 * junction/symlink to home. Canonicalise both sides with realpath and compare
 * case-insensitively on win32, then also refuse ancestors of home.
 */
export function isHomeOrAncestor(cwd: string): boolean {
  const canon = (p: string): string => {
    let out: string
    try { out = fs.realpathSync.native(p) } catch { out = path.resolve(p) }
    return process.platform === 'win32' ? out.toLowerCase() : out
  }
  const home = canon(os.homedir())
  const dir = canon(cwd)
  if (dir === home) return true
  // home is INSIDE dir (dir is an ancestor of home) → relative path has no '..'
  // and isn't absolute. home OUTSIDE dir → relative starts with '..'.
  const rel = path.relative(dir, home)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}
