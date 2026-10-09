import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

/**
 * Validate that a user-supplied path resolves within an allowed root directory.
 * Prevents path traversal attacks (e.g., ../../etc/passwd).
 * Throws an error if the path is outside the allowed root.
 */
export function validatePath(userPath: string, allowedRoot: string): string {
  const resolved = path.resolve(userPath)
  const normalizedRoot = path.resolve(allowedRoot) + path.sep
  if (!resolved.startsWith(normalizedRoot) && resolved !== path.resolve(allowedRoot)) {
    throw new Error(`Path traversal denied: ${userPath} is outside ${allowedRoot}`)
  }
  return resolved
}

/**
 * Validate that a path is within the Claude memory directory (~/.claude/projects/).
 *
 * P2.5: string containment alone only checks the literal path. A symlink or
 * junction planted inside the memory dir could point outside it, so the real
 * (link-resolved) path is re-checked for containment on every op. Destructive
 * ops additionally refuse to act through a symlink at all.
 */
export function validateMemoryPath(userPath: string, opts?: { destructive?: boolean }): string {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects')
  const resolved = validatePath(userPath, claudeProjectsDir)

  let realRoot: string
  try {
    realRoot = fs.realpathSync.native(claudeProjectsDir)
  } catch {
    // Memory dir doesn't exist yet -> nothing to read/delete; let the caller's
    // own fs op surface a clean ENOENT.
    return resolved
  }
  let realTarget: string
  try {
    realTarget = fs.realpathSync.native(resolved)
  } catch {
    // Target doesn't exist (already gone / not created). String containment
    // stands; the caller's fs op fails cleanly if it is truly absent.
    return resolved
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
    throw new Error(`Path traversal denied: ${userPath} resolves outside the memory dir`)
  }

  // Destructive ops (delete / frontmatter rewrite) must never act THROUGH a
  // symlink, even one that currently resolves back inside the root.
  if (opts?.destructive) {
    let isLink = false
    try { isLink = fs.lstatSync(resolved).isSymbolicLink() } catch { /* gone -> caller's op fails cleanly */ }
    if (isLink) {
      throw new Error(`Refusing a destructive op on a symlinked memory entry: ${userPath}`)
    }
  }

  return resolved
}

// ---------------------------------------------------------------------------
// WP2 PR 4, P4.4 (rows 55, 56): a provider account's own folders -- its
// memories folder and its log folders. The path forms and the checks a folder
// must pass before main reads in it or hands it to the shell.
// ---------------------------------------------------------------------------

type PathPlatform = NodeJS.Platform

/** Device names Windows resolves in any folder (`C:\logs\CON` is the console). */
const WIN_DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i

/**
 * Why a path is not a fully qualified LOCAL path, judged by its form alone,
 * before any file or shell call; null when its form is acceptable.
 *
 * On Windows only a drive path (`C:\...`) passes: never a UNC share
 * (`\\host\share`, `//host/share`: `shell.openPath` on a share opens a network
 * connection), a device or verbatim path (`\\.\`, `\\?\`, `\??\`), a drive-
 * or root-relative path (`C:x`, `\x`), a colon after the drive (an alternate
 * data stream), a reserved character or device name, or a name ending in a
 * dot or a space (Win32 drops those, so the shell and Node could reach
 * different folders). Everywhere: no control character, no empty, `.` or `..`
 * segment (no spelling that resolves elsewhere), and on POSIX an absolute
 * path that does not start with `//`.
 */
export function localPathFormProblem(p: unknown, platform: PathPlatform = process.platform): string | null {
  if (typeof p !== 'string' || p.length === 0) return 'empty'
  if (p.length > 4096) return 'too-long'
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'control-character'
  if (platform === 'win32') {
    if (/^[\\/]{2}/.test(p)) return 'unc-or-device'
    if (/^[\\/]\?\?[\\/]/.test(p)) return 'device'
    if (!/^[A-Za-z]:[\\/]/.test(p)) return 'not-fully-qualified'
    const rest = p.slice(3)
    if (rest.includes(':')) return 'stream'
    if (/[<>"|?*]/.test(rest)) return 'reserved-character'
    if (rest === '') return null
    const segs = rest.split(/[\\/]/)
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i]
      if (s === '') {
        // One trailing separator is a folder written as such; any other gap is not.
        if (i === segs.length - 1) continue
        return 'empty-segment'
      }
      if (s === '.' || s === '..') return 'dot-segment'
      if (/[. ]$/.test(s)) return 'trailing-dot-or-space'
      if (WIN_DEVICE_NAME.test(s)) return 'device-name'
    }
    return null
  }
  if (!p.startsWith('/')) return 'not-fully-qualified'
  if (p.startsWith('//')) return 'unc-or-device'
  const segs = p.slice(1).split('/')
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (s === '') {
      if (i === segs.length - 1) continue
      return 'empty-segment'
    }
    if (s === '.' || s === '..') return 'dot-segment'
  }
  return null
}

/**
 * The case rule for the account-folder checks' real-path test (samePathForm):
 * whether the real path the file system gave back is the path that reached
 * it, in another case. Chosen to follow how Windows compares names: NTFS
 * upper-cases each UTF-16 unit through a one-to-one upcase table. So a unit is
 * folded only to an upper case that is itself one unit and lowers back to it
 * (a plain letter pair, o and O with umlauts included); anything else is kept
 * as written: the Kelvin sign is not k, dotless i is not I, sharp s never
 * becomes two letters, a surrogate is never folded. A volume can keep apart a
 * pair this folds (a case-sensitive folder or disk), so it never decides
 * whether a path is inside a folder: pathInside compares spellings exactly;
 * and a folded match alone never passes the real-path test: isOwnRealPath
 * asks the folder whether it reads both spellings as one entry.
 */
export function foldPathCase(s: string): string {
  return s.replace(/[a-z]|[^\x00-\x7f]/g, (c) => {
    // Lowering back to the one unit `c` also means `u` is one unit.
    const u = c.toUpperCase()
    return u.toLowerCase() === c ? u : c
  })
}

/** A path as the checks compare it: on Windows either separator, and a
 *  trailing separator dropped (a root's kept). Case is not touched here. */
function spelled(p: string, platform: PathPlatform): string {
  const sep = platform === 'win32' ? '\\' : '/'
  let s = platform === 'win32' ? p.replace(/\//g, '\\') : p
  while (s.length > 1 && s.endsWith(sep) && !(platform === 'win32' && /^[A-Za-z]:\\$/.test(s))) s = s.slice(0, -1)
  return s
}

const caseKey = (s: string, platform: PathPlatform): string => (platform === 'win32' || platform === 'darwin' ? foldPathCase(s) : s)

/**
 * Two spellings of one path as the platform compares them: on Windows and
 * macOS by foldPathCase (Windows also takes either separator); elsewhere
 * exact. A trailing separator is ignored, a root's is kept. The spelling half
 * of the real-path test (isOwnRealPath), never containment (pathInside).
 */
export function samePathForm(a: string, b: string, platform: PathPlatform = process.platform): boolean {
  return caseKey(spelled(a, platform), platform) === caseKey(spelled(b, platform), platform)
}

/**
 * Whether `folder` reads `name` and `variant` (the same name in another case)
 * as one entry: each is looked at with lstat (the name itself, never what a
 * link there points to), and the two must have the same device and file id.
 * A case-insensitive folder answers both spellings with its one entry; a
 * case-sensitive one (a case-sensitive disk, or a Windows folder with case
 * sensitivity turned on) can hold two entries, or a link under one spelling to
 * the other. A file system that gives no file id (0) cannot say, so that
 * answers false too, as any error does.
 */
export async function folderIgnoresCase(
  folder: string,
  name: string,
  variant: string,
  platform: PathPlatform,
  files: FolderCheckFs,
): Promise<boolean> {
  const sep = platform === 'win32' ? '\\' : '/'
  const base = folder.endsWith(sep) ? folder : folder + sep
  try {
    const [a, b] = await Promise.all([files.lstat(base + name, { bigint: true }), files.lstat(base + variant, { bigint: true })])
    return a.ino !== 0n && a.dev === b.dev && a.ino === b.ino
  } catch {
    return false
  }
}

/**
 * The real-path test of the account-folder checks: `real`, the path the file
 * system gave back for `target` (realpath), is `target` itself, so no link or
 * junction lies on the way. Spellings that match exactly answer without a file
 * call. Spellings that match only as samePathForm folds them (another case, on
 * Windows or macOS) match only where each folder holding a name spelled in
 * another case reads both spellings as one entry (folderIgnoresCase): on a
 * case-sensitive disk or folder the other spelling can be a link. A Windows
 * drive letter is the same drive in any case. Any error answers false.
 */
export async function isOwnRealPath(real: string, target: string, platform: PathPlatform, files: FolderCheckFs): Promise<boolean> {
  const r = spelled(real, platform)
  const t = spelled(target, platform)
  if (r === t) return true
  if (caseKey(r, platform) !== caseKey(t, platform)) return false
  const sep = platform === 'win32' ? '\\' : '/'
  const realNames = r.split(sep)
  const targetNames = t.split(sep)
  if (realNames.length !== targetNames.length) return false
  // Index 0 is the root: '' on POSIX, the drive on Windows.
  for (let i = 1; i < realNames.length; i++) {
    if (realNames[i] === targetNames[i]) continue
    const folder = realNames.slice(0, i).join(sep) || sep
    if (!(await folderIgnoresCase(folder, realNames[i], targetNames[i], platform, files))) return false
  }
  return true
}

/**
 * `target`'s path below `root` (as `target` writes it), when it is strictly
 * inside it spelled as `root` is spelled (on Windows either separator); else
 * null. Case is never folded here, on any platform: a folder spelled in
 * another case can be another folder (a case-sensitive folder or disk), and
 * the listing only ever hands out paths built from the root's own spelling.
 * Both must already have a local form (localPathFormProblem): no `.` or `..`
 * segment is resolved here, so a name that merely starts with two dots is
 * inside.
 */
export function pathInside(root: string, target: string, platform: PathPlatform = process.platform): string | null {
  const sep = platform === 'win32' ? '\\' : '/'
  const r = spelled(root, platform)
  const t = spelled(target, platform)
  const prefix = r.endsWith(sep) ? r : r + sep
  if (t.length <= prefix.length || !t.startsWith(prefix)) return null
  return t.slice(prefix.length)
}

/** The file calls the folder checks make (fs.promises' own; a test passes
 *  its own). Stats are asked for as bigint, so a 64-bit file id compares
 *  exactly. */
export interface FolderCheckFs {
  lstat(p: string, opts: { bigint: true }): Promise<fs.BigIntStats>
  realpath(p: string): Promise<string>
}

export const realFolderCheckFs: FolderCheckFs = {
  lstat: (p, opts) => fs.promises.lstat(p, opts),
  realpath: (p) => fs.promises.realpath(p),
}

/** A refusal from the account-folder checks: why, as the caller's own answer
 *  code. The message names no path. */
export class AccountPathRefused extends Error {
  constructor(public readonly code: 'refused' | 'not-found', reason: string) {
    super(`Refused: ${reason}`)
    this.name = 'AccountPathRefused'
  }
}

/** True for a name that is, or that Windows would read as, `.git`. */
export function isGitSegment(name: string): boolean {
  return /^\.git$/i.test(name.replace(/[. ]+$/, ''))
}

/** A file an account-memory check let through: its path, the memories folder
 *  it is in, and the identity it had, which a read or delete compares again
 *  on what it opens. */
export interface AccountMemoryTarget {
  path: string
  root: string
  dev: bigint
  ino: bigint
  size: bigint
}

/**
 * P4.4: a provider account's memory file, by the path the Memory page's
 * listing gave the renderer, checked against the memories folders main names
 * NOW (`roots`, from the account folders, never from the renderer). Beside
 * validateMemoryPath, which keeps Claude's store.
 *
 * Refused (AccountPathRefused): a path whose form is not a fully qualified
 * local path (localPathFormProblem: a UNC or device path never reaches a file
 * call); one not strictly inside one of the roots as the root is spelled
 * (pathInside: another case is outside); one with a `.git` segment
 * (a provider may keep its memories folder as a git repository: nothing in
 * `.git` is listed, read or deleted); a root or file whose real path is not its own (a
 * link or junction anywhere on the way, an 8.3 short name, a substituted
 * drive); a file that is a link, not a plain file, or has a second name (a
 * hard link could be another folder's file). Every check already refuses a
 * link, so `destructive` asks for nothing more; it is kept for the call
 * sites' symmetry with validateMemoryPath.
 */
export async function validateAccountMemoryPath(
  userPath: unknown,
  roots: readonly string[],
  opts: { destructive?: boolean; platform?: PathPlatform; fs?: FolderCheckFs } = {},
): Promise<AccountMemoryTarget> {
  const platform = opts.platform ?? process.platform
  const files = opts.fs ?? realFolderCheckFs
  const form = localPathFormProblem(userPath, platform)
  if (form) throw new AccountPathRefused('refused', `not a local path (${form})`)
  const target = userPath as string
  let root: string | null = null
  let rel = ''
  for (const r of roots) {
    if (localPathFormProblem(r, platform)) continue
    const candidate = pathInside(r, target, platform)
    if (candidate !== null) {
      root = r
      rel = candidate
      break
    }
  }
  if (root === null) throw new AccountPathRefused('refused', 'outside every account memories folder')
  if (rel.split(/[\\/]/).some(isGitSegment)) throw new AccountPathRefused('refused', 'inside .git')

  // lstat looks at the last name itself: a link there is not a plain file.
  let st: fs.BigIntStats
  try {
    st = await files.lstat(target, { bigint: true })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code
    throw new AccountPathRefused(code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'refused', 'the file could not be checked')
  }
  if (!st.isFile()) throw new AccountPathRefused('refused', 'not a plain file (a folder, a link or a device)')
  if (st.nlink !== 1n) throw new AccountPathRefused('refused', 'a file with another name')
  // Its real path is its own: no link or junction anywhere on the way, the
  // memories folder itself included.
  let realTarget: string
  try {
    realTarget = await files.realpath(target)
  } catch {
    throw new AccountPathRefused('refused', 'the file could not be resolved')
  }
  if (!(await isOwnRealPath(realTarget, target, platform, files))) throw new AccountPathRefused('refused', 'reached through a link')
  return { path: target, root, dev: st.dev, ino: st.ino, size: st.size }
}
