// The file the carried-conversation marks are kept in (ADR-023): a small JSON
// file in the app's own `providers/` configuration folder, next to the account
// registry and never inside an account's folder. It holds, for each
// conversation a Switch Account carried into an account's folder, which
// account folder, which conversation and when; nothing about its content. It
// is read when first needed, replaced atomically (staged, then renamed) when a
// mark is added or an account's marks are dropped, and owner-only on POSIX.
//
// Fails closed (rounds 2 and 3): the file is looked at before it is read (a
// plain file within its size cap, never a link, folder or oversize file), and
// one that is not that is reported as corrupt for its owner to set aside;
// setting it aside renames it (the newest few are kept), never overwrites it,
// and puts the owner's replacement in its place in the one step: if the
// replacement cannot be written the file is put back as it was, so the next
// start finds it again rather than finding nothing.
//
// Injected, like the registry's own port, so it names no resources directory
// and every branch is testable without a disk.
import nodeFs from 'node:fs'
import nodePath from 'node:path'

export const CARRY_MARKS_FILENAME = 'carry-marks.json'
/** The most bytes the file may hold: a file this code wrote is far smaller. */
export const CARRY_MARKS_MAX_BYTES = 4 * 1024 * 1024
/** The set-aside copies of a file that was not what this code wrote, kept. */
export const CARRY_MARKS_ASIDE_KEPT = 3
const ASIDE_RE = /^carry-marks\.json\.bad-(\d+)$/

/** What the marks' owner needs of a file: the same shape on every platform. */
export interface CarryMarksFilePort {
  /** The file's text; its absence; "cannot be read now" (asked again after a
   *  wait); "not ready" (the resources folder is not known yet, which is no
   *  failed read: asked again at once); or "corrupt": there, but not a plain
   *  file within the size cap. */
  read(): { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'unavailable' } | { kind: 'not-ready' } | { kind: 'corrupt' }
  /** Replace the file. Throws on any failure. */
  write(text: string): void
  /** Rename the file out of its place and put `replacement` in it, in one
   *  step: true when both were done, false (the file as it was) otherwise. */
  setAside(replacement: string): boolean
}

export interface CarryMarksFileDeps {
  /** The folder the file lives in (`<resources>/providers`), or null while the
   *  registry has not been loaded from a resources directory. */
  directory(): string | null
  /** Make that folder, refusing to go through a link. */
  mkdirSecure(dir: string): void
  /** The app's one atomic write (staging, then rename). */
  atomicWrite(file: string, data: string, options?: { mode: number }): void
  posix: boolean
  /** The clock a set-aside copy is named with. */
  now?: () => number
  /** Replaces the file system's calls, for a test. */
  fs?: Pick<typeof nodeFs, 'readFileSync' | 'statSync' | 'lstatSync' | 'renameSync' | 'readdirSync' | 'unlinkSync'>
}

const errCode = (e: unknown): unknown => (e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined)

export function createCarryMarksFilePort(deps: CarryMarksFileDeps): CarryMarksFilePort {
  const fs = deps.fs ?? nodeFs
  return {
    read() {
      const dir = deps.directory()
      if (!dir) return { kind: 'not-ready' }
      const file = nodePath.join(dir, CARRY_MARKS_FILENAME)
      let entry: nodeFs.Stats
      try {
        entry = fs.lstatSync(file)
      } catch (e) {
        if (errCode(e) !== 'ENOENT') return { kind: 'unavailable' }
        // Absence only when the folder above it is there: an unmounted drive
        // answers ENOENT for every path, and a mark written there would be lost.
        try {
          return fs.statSync(nodePath.dirname(dir)).isDirectory() ? { kind: 'missing' } : { kind: 'unavailable' }
        } catch {
          return { kind: 'unavailable' }
        }
      }
      // A link, a folder or anything but a plain file is not one this code made,
      // and a file past the cap cannot be one it wrote: neither is read.
      if (!entry.isFile() || entry.size > CARRY_MARKS_MAX_BYTES) return { kind: 'corrupt' }
      try {
        return { kind: 'ok', text: fs.readFileSync(file, 'utf8') }
      } catch {
        return { kind: 'unavailable' }
      }
    },
    write(text) {
      const dir = deps.directory()
      if (!dir) throw new Error('the resources directory is not known yet')
      deps.mkdirSecure(dir)
      deps.atomicWrite(nodePath.join(dir, CARRY_MARKS_FILENAME), text, deps.posix ? { mode: 0o600 } : undefined)
    },
    setAside(replacement) {
      const dir = deps.directory()
      if (!dir) return false
      const file = nodePath.join(dir, CARRY_MARKS_FILENAME)
      let at = Date.now()
      try { const n = deps.now ? deps.now() : at; if (Number.isFinite(n)) at = Math.floor(n) } catch { /* the wall clock */ }
      const aside = nodePath.join(dir, `${CARRY_MARKS_FILENAME}.bad-${at}`)
      let moved = false
      try {
        fs.renameSync(file, aside)
        moved = true
      } catch (e) {
        // Already gone is fine (the replacement is still wanted); anything else is a failure.
        if (errCode(e) !== 'ENOENT') return false
      }
      try {
        deps.atomicWrite(file, replacement, deps.posix ? { mode: 0o600 } : undefined)
      } catch {
        // Put it back, so the next start finds it as it was and not as a missing file.
        if (moved) { try { fs.renameSync(aside, file) } catch { /* the copy stays beside it */ } }
        return false
      }
      // The newest few stay; the rest go (only names this function gives).
      try {
        const names = fs.readdirSync(dir).map((n) => ({ n, t: ASIDE_RE.exec(n) })).filter((x): x is { n: string; t: RegExpExecArray } => x.t !== null)
        names.sort((a, b) => Number(b.t[1]) - Number(a.t[1]))
        for (const old of names.slice(CARRY_MARKS_ASIDE_KEPT)) {
          try { fs.unlinkSync(nodePath.join(dir, old.n)) } catch { /* left for the next time */ }
        }
      } catch { /* the folder could not be listed: nothing is trimmed */ }
      return true
    },
  }
}
