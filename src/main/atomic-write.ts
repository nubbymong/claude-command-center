import { writeFileSync, renameSync, unlinkSync, readdirSync, statSync } from 'fs'
import { join, dirname, basename } from 'path'
import { randomUUID } from 'crypto'

/**
 * The one atomic file write for the main process.
 *
 * Everything here was learned the hard way and each property is load-bearing, so
 * none of them are safe to "simplify" away:
 *
 * 1. `flag: 'wx'` -- O_CREAT|O_EXCL|O_WRONLY. `open(2)` with O_CREAT|O_EXCL fails
 *    EEXIST on an existing file AND on a symlink (even a dangling one), so a link
 *    pre-planted at the staging path cannot redirect the write. It is ALSO what
 *    makes `mode` apply: a mode passed to open(2) is honoured only on creation, so
 *    writing into a pre-existing inode silently inherits that inode's permissions.
 *    One flag closes both halves. (GHSA-pwfw-2ggq-569x)
 * 2. A `randomUUID()` staging name, so the path cannot be predicted and
 *    pre-created. A pid plus a counter is guessable; that was the reported bug.
 * 3. A bounded retry of the rename on Windows only. There, replacing an existing
 *    file fails EPERM/EACCES/EBUSY while any other process holds a handle on
 *    either path -- and Defender, the Search indexer and backup agents all open a
 *    file the instant its write handle closes. The window is milliseconds, so it
 *    never fires idle and is common under load (#213: 2 of 6 unit-suite runs red
 *    under CPU pressure; 0 of 8 after).
 *
 * Deliberately NOT retried on POSIX. `rename(2)` there never produces those codes
 * transiently -- EACCES is a sticky-bit or permission denial and EBUSY is a
 * mountpoint, neither of which a wait fixes. Retrying would burn the whole budget
 * of blocking sleep on every permission-denied write for nothing.
 *
 * Throws on failure, having removed its staging file first, so every call site
 * keeps whatever contract it already had -- config-manager returns false,
 * conductor-mcp-server refuses to fall back, sentinel-state swallows,
 * session-state rethrows.
 */

/** ~155ms of patience, spent only when a rename actually loses the race. */
const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80]
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RETRY_RENAME = process.platform === 'win32'

/** A UUID collision is a 128-bit coincidence; more than one EEXIST in a row means
 *  something is sitting on the path deliberately, so fail rather than loop. */
const STAGING_NAME_ATTEMPTS = 3

/** `<name>.<uuid>.tmp` -- what this module leaves behind if it is killed mid-write. */
const STAGING_RE = /\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i
const STALE_STAGING_MS = 60 * 60 * 1000

function sleepSync(ms: number): void {
  // These writers are synchronous and called from synchronous code, so the wait
  // has to block rather than yield. It runs on the Electron main thread, which is
  // why the budget is small, bounded, and Windows-only.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * A process killed between the write and the rename strands its staging file, and
 * a random name is never reused, so nothing reclaims it -- unlike the fixed
 * `<file>.tmp` this replaced, which the next write simply overwrote. Left alone
 * these accumulate indefinitely, and for the credential writers each one is a
 * complete token blob. Sweep them, but only once per directory per process: a
 * readdir on every write would be a real cost on a busy CONFIG dir.
 */
const sweptDirs = new Set<string>()
function sweepStaleStaging(dir: string, name: string): void {
  if (sweptDirs.has(dir)) return
  sweptDirs.add(dir)
  try {
    const cutoff = Date.now() - STALE_STAGING_MS
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith(name + '.') || !STAGING_RE.test(entry)) continue
      const full = join(dir, entry)
      try {
        // Age-gated so a staging file another process is writing RIGHT NOW is
        // never pulled out from under it.
        if (statSync(full).mtimeMs < cutoff) unlinkSync(full)
      } catch { /* best-effort */ }
    }
  } catch { /* the directory may not exist yet; nothing to sweep */ }
}

/** Rename `from` over `to`, retrying only the transient Windows sharing errors. */
export function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err: any) {
      if (!RETRY_RENAME || !TRANSIENT_RENAME_CODES.has(err?.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

export interface AtomicWriteOptions {
  /** POSIX mode for the staged file. Ignored on win32, as `writeFileSync` does. */
  mode?: number
  encoding?: BufferEncoding
}

/**
 * Write `data` to `file` atomically. Throws if the write or the rename fails,
 * having first removed the staging file so the next writer never trips over it.
 *
 * Does NOT create the parent directory. Callers own that, and the credential
 * writers must use `mkdirSecure` rather than a bare mkdir -- this guards the
 * staging FILE, and nothing here can see a link planted on a DIRECTORY above it.
 */
export function atomicWriteFileSync(file: string, data: string | Uint8Array, opts?: AtomicWriteOptions): void {
  const dir = dirname(file)
  const name = basename(file)
  sweepStaleStaging(dir, name)

  for (let attempt = 0; ; attempt++) {
    const tmp = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmp, data, {
        flag: 'wx',
        encoding: opts?.encoding ?? 'utf-8',
        ...(opts?.mode != null ? { mode: opts.mode } : {})
      })
    } catch (err: any) {
      if (err?.code === 'EEXIST' && attempt < STAGING_NAME_ATTEMPTS) continue
      // Which stage failed is load-bearing for the two callers that keep a
      // NON-atomic fallback: falling back on a staging-write failure opens the
      // real target with O_TRUNC and destroys it, which is strictly worse than
      // the failure it was trying to paper over.
      if (err && typeof err === 'object') err.atomicWriteStage = 'write'
      throw err
    }
    try {
      renameWithRetry(tmp, file)
    } catch (err: any) {
      try { unlinkSync(tmp) } catch { /* best-effort */ }
      if (err && typeof err === 'object') err.atomicWriteStage = 'rename'
      throw err
    }
    return
  }
}
