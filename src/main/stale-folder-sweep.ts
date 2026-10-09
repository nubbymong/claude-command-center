// Folders a run makes for itself and removes after it (P3.9 round 1: the
// Codex model list read's empty home, Sentinel's analysis folder) can be left
// behind by a crash or a quit mid-run. The next run sweeps them: only direct
// children of the one parent folder the runs use, only names with the run's
// own prefix, only real folders (a link is never followed or removed), on
// POSIX only folders this user owns, and only past an age no live run reaches.
// The parent is looked at first: one that is a link, or not a folder, lists
// nothing. A caller that checks its parent (parentHolds) is asked again just
// before the listing and before each removal; the sweep stops at the first
// answer that it no longer holds. Never throws. Insights' and Sentinel's
// folders are made owner-only on POSIX through ownerOnlyThroughHandle, below.
import * as nodeFs from 'fs'
import * as path from 'path'

export interface SweepFs {
  readdirSync(dir: string): string[]
  lstatSync(p: string): { isDirectory(): boolean; isSymbolicLink(): boolean; mtimeMs: number; uid: number }
  rmSync(p: string, opts: { recursive: true; force: true }): void
}

export interface SweepOptions {
  /** Folders younger than this are left alone (a run may still be using them). */
  maxAgeMs: number
  now?: number
  fs?: SweepFs
  /** The current user's id on POSIX (process.getuid); absent on Windows. */
  uid?: number | null
  /** The caller's own check that `parent` is still the folder it checked,
   *  asked before the listing and again before each removal: false (or a
   *  throw) stops the sweep there. */
  parentHolds?: () => boolean
}

/** Removes stale own-prefix folders directly under `parent`; returns their names. */
export function sweepStaleFolders(parent: string, prefix: string, opts: SweepOptions): string[] {
  const fs = opts.fs ?? (nodeFs as unknown as SweepFs)
  const now = opts.now ?? Date.now()
  const uid = opts.uid !== undefined ? opts.uid : (typeof process.getuid === 'function' ? process.getuid() : null)
  const removed: string[] = []
  if (typeof prefix !== 'string' || prefix.length < 4) return removed
  const holds = (): boolean => {
    if (!opts.parentHolds) return true
    try { return opts.parentHolds() === true } catch { return false }
  }
  try {
    const top = fs.lstatSync(parent)
    if (top.isSymbolicLink() || !top.isDirectory()) return removed
  } catch { return removed }
  if (!holds()) return removed
  let names: string[]
  try { names = fs.readdirSync(parent) } catch { return removed }
  for (const name of names) {
    try {
      if (typeof name !== 'string' || !name.startsWith(prefix) || name.length === prefix.length) continue
      if (name !== path.basename(name) || name.includes('/') || name.includes('\\')) continue
      const full = path.join(parent, name)
      const st = fs.lstatSync(full)
      if (st.isSymbolicLink() || !st.isDirectory()) continue
      if (uid !== null && st.uid !== uid) continue
      if (!(now - st.mtimeMs > opts.maxAgeMs)) continue
      if (!holds()) break
      fs.rmSync(full, { recursive: true, force: true })
      removed.push(name)
    } catch { /* one folder never stops the sweep */ }
  }
  return removed
}

/** POSIX: makes `dir` owner-only (0700) through a handle on the folder
 *  `seen` (its lstat, bigint) describes, so the change never lands on
 *  anything put in its place after that lstat. The handle is opened without
 *  following a link, and the change is made only when it is a folder, this
 *  user's, and that same folder (device and inode); false, changing nothing,
 *  when it is not or cannot be opened. A change the system refuses is left
 *  to the caller's checks after it. Never throws. */
export function ownerOnlyThroughHandle(dir: string, seen: nodeFs.BigIntStats): boolean {
  const fs = nodeFs
  let fd: number | null = null
  try {
    if (typeof process.getuid !== 'function') return false
    fd = fs.openSync(dir, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0) | (fs.constants.O_NOFOLLOW ?? 0))
    const open = fs.fstatSync(fd, { bigint: true })
    if (!open.isDirectory() || open.uid !== BigInt(process.getuid()) || open.dev !== seen.dev || open.ino !== seen.ino) return false
    try { fs.fchmodSync(fd, 0o700) } catch { /* checked after either way */ }
    return true
  } catch {
    return false
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* already closed */ }
  }
}
