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
  const real = (p: string): string => {
    try { return fs.realpathSync.native(p) } catch { return path.resolve(p) }
  }
  // Filesystem IDENTITY (device:inode), not the path string. A string compare
  // misses the many spellings of one directory on Windows — case-variant, the
  // \\?\ / \\.\ prefixes, a `subst` drive, a junction/symlink, an 8.3 short
  // name, and the \\host\C$ admin-share form (which realpath returns verbatim,
  // so even a canonicalised string compare misses it). statSync collapses them
  // all to the same dev:ino. (adversarial review, #188 rounds 2–3.)
  const idOf = (p: string): string | null => {
    // bigint so a large NTFS file-reference number (> 2^53) isn't rounded — a
    // lossy Number ino could bucket two distinct dirs together and wrongly DENY
    // a legit project dir (over-deny, never exposure). (adversarial review, #188.)
    try { const s = fs.statSync(p, { bigint: true }); return `${s.dev}:${s.ino}` } catch { return null }
  }
  const home = real(os.homedir())
  const dir = real(cwd)
  const dirId = idOf(dir)
  if (dirId != null) {
    // Walk home up to the filesystem root; dir matches home itself or any
    // ancestor of home when their identities are equal.
    let cur = home
    while (true) {
      if (idOf(cur) === dirId) return true
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    return false
  }
  // Fallback for a path that doesn't exist on disk (statSync failed): a
  // normalised string comparison. resolveCwd would already have mapped a
  // non-existent path to home before this is reached, so this is belt-and-braces.
  const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
  const h = norm(home), d = norm(dir)
  if (d === h) return true
  const rel = path.relative(d, h)
  return rel !== '' && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel)
}
