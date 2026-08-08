import { writeFileSync, renameSync, unlinkSync, readdirSync, lstatSync } from 'fs'
import { join, dirname } from 'path'
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
 * 3. A bounded retry of the rename, per-platform by errno -- see
 *    `isTransientRenameError`. On Windows, replacing an existing file fails
 *    EPERM/EACCES/EBUSY while any other process holds a handle on either path,
 *    and Defender, the Search indexer and backup agents all open a file the
 *    instant its write handle closes. The window is milliseconds, so it never
 *    fires idle and is common under load (#213: 2 of 6 unit-suite runs red under
 *    CPU pressure; 0 of 8 after). EBUSY is retried on every platform, because the
 *    resources dir may live on a network drive.
 *
 * Throws on failure, having removed its staging file first, so every call site
 * keeps whatever contract it already had -- config-manager returns false,
 * conductor-mcp-server refuses to fall back, sentinel-state swallows,
 * session-state rethrows.
 */

/** ~155ms of patience, spent only when a rename actually loses the race. */
const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80]

/**
 * Which rename errors are worth waiting out, per platform.
 *
 * EBUSY is transient EVERYWHERE. The resources directory is user-selectable and
 * documented as able to live on a network drive, and SMB/NFS return EBUSY on a
 * rename that a moment later succeeds. A blanket win32-only gate would drop
 * protection this app already had there.
 *
 * EPERM and EACCES are Windows-only. On Windows they are the scanner race --
 * a handle held without delete-sharing. On POSIX they are a sticky-bit or
 * permission denial that no amount of waiting fixes, so retrying would just burn
 * the whole blocking budget on an error path.
 *
 * `platform` is a parameter rather than a module-load constant so BOTH CI legs
 * exercise both rules; a constant meant whichever runner you were on silently
 * decided which half of this was tested.
 */
export function isTransientRenameError(code: string | undefined, platform: string = process.platform): boolean {
  if (code === 'EBUSY') return true
  return platform === 'win32' && (code === 'EPERM' || code === 'EACCES')
}

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
function sweepStaleStaging(dir: string): void {
  if (sweptDirs.has(dir)) return
  sweptDirs.add(dir)
  try {
    const cutoff = Date.now() - STALE_STAGING_MS
    for (const entry of readdirSync(dir)) {
      // Match on the staging pattern ALONE, not on the file being written now.
      // The memo is keyed by directory, so filtering by the current name meant
      // the first file written to a directory marked the whole directory swept
      // and every OTHER name's orphans survived forever -- which is most of
      // them in ~/.claude (settings-<sid>.json, mcp-<sid>.json) and CONFIG.
      if (!STAGING_RE.test(entry)) continue
      const full = join(dir, entry)
      try {
        // lstat, not stat: this must never resolve a link. An entry matching the
        // staging pattern that is a SYMLINK was not left by us -- we only ever
        // create staging files with O_EXCL -- so it is something someone else
        // put there, and following it would turn a tidy-up into an unlink of
        // whatever it points at. Skip it entirely rather than delete the link.
        const st = lstatSync(full)
        if (st.isSymbolicLink()) continue
        // Age-gated so a staging file another process is writing RIGHT NOW is
        // never pulled out from under it.
        if (st.mtimeMs < cutoff) unlinkSync(full)
      } catch { /* best-effort */ }
    }
  } catch { /* the directory may not exist yet; nothing to sweep */ }
}

/** Rename `from` over `to`, waiting out only the errors worth waiting out. */
export function renameWithRetry(from: string, to: string, retry = true): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err: any) {
      if (!retry || !isTransientRenameError(err?.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

/**
 * Record which stage failed on the error itself.
 *
 * `defineProperty` inside a try, not a plain assignment: assigning to a frozen
 * or non-extensible Error throws TypeError, which would replace the real errno
 * with a confusing one. If it cannot be tagged, the caller's guard sees no tag
 * and fails closed -- which is the safe direction.
 */
function tagStage(err: unknown, stage: 'write' | 'rename'): void {
  if (!err || typeof err !== 'object') return
  try {
    Object.defineProperty(err, 'atomicWriteStage', {
      value: stage, configurable: true, writable: true, enumerable: false
    })
  } catch { /* frozen: leave it untagged, callers fail closed */ }
}

/**
 * True only when THIS error carries an own `atomicWriteStage` of 'rename'.
 *
 * `err.atomicWriteStage === 'rename'` would read through the prototype chain, so
 * a polluted `Object.prototype` could authorise the truncating fallback on a
 * staging-write failure. Own-property only, and false for anything untagged.
 */
export function isRenameStageFailure(err: unknown): boolean {
  return !!err && typeof err === 'object'
    && Object.hasOwn(err as object, 'atomicWriteStage')
    && (err as { atomicWriteStage?: unknown }).atomicWriteStage === 'rename'
}

export interface AtomicWriteOptions {
  /** POSIX mode for the staged file. Ignored on win32, as `writeFileSync` does. */
  mode?: number
  encoding?: BufferEncoding
  /**
   * Set false for a best-effort writer called in a LOOP. The retry blocks the
   * Electron main thread for up to ~155ms, which is fine once and not fine
   * twenty-five times in a row at boot (sentinel-state persists once per
   * finding). A writer that already swallows its own failures gains nothing
   * from waiting anyway.
   */
  retry?: boolean
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
  sweepStaleStaging(dirname(file))

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
      // O_CREAT means a failure AFTER the open (ENOSPC, EIO, EDQUOT) still
      // leaves a partial file behind, under a random name nothing will reuse.
      if (err?.code !== 'EEXIST') { try { unlinkSync(tmp) } catch { /* best-effort */ } }
      // Which stage failed is load-bearing for the two callers that keep a
      // NON-atomic fallback: falling back on a staging-write failure opens the
      // real target with O_TRUNC and destroys it, which is strictly worse than
      // the failure it was trying to paper over.
      tagStage(err, 'write')
      throw err
    }
    try {
      renameWithRetry(tmp, file, opts?.retry !== false)
    } catch (err: any) {
      try { unlinkSync(tmp) } catch { /* best-effort */ }
      tagStage(err, 'rename')
      throw err
    }
    return
  }
}
