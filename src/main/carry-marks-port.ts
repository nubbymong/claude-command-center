// The file the carried-conversation marks are kept in (ADR-023): a small JSON
// file in the app's own `providers/` configuration folder, next to the account
// registry and never inside an account's folder. It holds, for each
// conversation a Switch Account carried into an account's folder, which
// account folder, which conversation and when; nothing about its content. It
// is read when first needed, replaced atomically (staged, then renamed) when a
// mark is added or an account's marks are dropped, and owner-only on POSIX.
//
// Injected, like the registry's own port, so it names no resources directory
// and every branch is testable without a disk.
import nodeFs from 'node:fs'
import nodePath from 'node:path'

export const CARRY_MARKS_FILENAME = 'carry-marks.json'

/** What the marks' owner needs of a file: the same shape on every platform. */
export interface CarryMarksFilePort {
  /** The file's text, its absence, or "cannot be read now" (asked again later). */
  read(): { kind: 'ok'; text: string } | { kind: 'missing' } | { kind: 'unavailable' }
  /** Replace the file. Throws on any failure. */
  write(text: string): void
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
  /** Replaces the file system's reads, for a test. */
  fs?: Pick<typeof nodeFs, 'readFileSync' | 'statSync'>
}

const errCode = (e: unknown): unknown => (e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined)

export function createCarryMarksFilePort(deps: CarryMarksFileDeps): CarryMarksFilePort {
  const fs = deps.fs ?? nodeFs
  return {
    read() {
      const dir = deps.directory()
      if (!dir) return { kind: 'unavailable' }
      const file = nodePath.join(dir, CARRY_MARKS_FILENAME)
      try {
        return { kind: 'ok', text: fs.readFileSync(file, 'utf8') }
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
    },
    write(text) {
      const dir = deps.directory()
      if (!dir) throw new Error('the resources directory is not known yet')
      deps.mkdirSecure(dir)
      deps.atomicWrite(nodePath.join(dir, CARRY_MARKS_FILENAME), text, deps.posix ? { mode: 0o600 } : undefined)
    },
  }
}
