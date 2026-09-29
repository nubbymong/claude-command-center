// Folders a run makes for itself and removes after it (P3.9 round 1: the
// Codex model list read's empty home, Sentinel's analysis folder) can be left
// behind by a crash or a quit mid-run. The next run sweeps them: only direct
// children of the one parent folder the runs use, only names with the run's
// own prefix, only real folders (a link is never followed or removed), on
// POSIX only folders this user owns, and only past an age no live run reaches.
// Never throws.
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
}

/** Removes stale own-prefix folders directly under `parent`; returns their names. */
export function sweepStaleFolders(parent: string, prefix: string, opts: SweepOptions): string[] {
  const fs = opts.fs ?? (nodeFs as unknown as SweepFs)
  const now = opts.now ?? Date.now()
  const uid = opts.uid !== undefined ? opts.uid : (typeof process.getuid === 'function' ? process.getuid() : null)
  const removed: string[] = []
  if (typeof prefix !== 'string' || prefix.length < 4) return removed
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
      fs.rmSync(full, { recursive: true, force: true })
      removed.push(name)
    } catch { /* one folder never stops the sweep */ }
  }
  return removed
}
