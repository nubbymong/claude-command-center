/**
 * PR-level ADR-009 round 2 (K5): a file's first line, read up to its first
 * newline and no further than a bound, through a small file port (node's fs by
 * default). One reader for the rollout lookup (rollout-lookup.ts, the session
 * watchers) and the transcripts worker (its own injectable port), so both read
 * a rollout's session_meta line the same way and to the same bound.
 *
 * Imports node's fs only, so the worker thread and the provider packages can
 * both use it. No default export (project convention).
 */
import * as fs from 'fs'

/** The most of a first line that is read: a session_meta line carries the
 *  base instructions (about 22 KB on 0.133), well under this. */
export const FIRST_LINE_MAX_BYTES = 1024 * 1024

/** The calls the reader makes; node's fs has them. */
export interface FirstLineFs {
  openSync(path: string, flags: string): number
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number
  closeSync(fd: number): void
}

/** A file's first line, read up to the first newline: `line`; `partial`
 *  while it is still being written (no newline yet: read it again later);
 *  `too-long` when it runs past the bound. Null when the file cannot be read
 *  just now. */
export type FirstLine = { kind: 'line'; line: string } | { kind: 'partial' } | { kind: 'too-long' }

export function readBoundedFirstLine(file: string, io: FirstLineFs = fs, max: number = FIRST_LINE_MAX_BYTES): FirstLine | null {
  let fd: number | null = null
  try {
    fd = io.openSync(file, 'r')
    const chunk = Buffer.alloc(64 * 1024)
    const parts: Buffer[] = []
    let total = 0
    while (total < max) {
      const n = io.readSync(fd, chunk, 0, Math.min(chunk.length, max - total), total)
      if (n <= 0) return { kind: 'partial' }
      const nl = chunk.subarray(0, n).indexOf(0x0a)
      if (nl >= 0) {
        parts.push(Buffer.from(chunk.subarray(0, nl)))
        return { kind: 'line', line: Buffer.concat(parts).toString('utf-8') }
      }
      parts.push(Buffer.from(chunk.subarray(0, n)))
      total += n
    }
    return { kind: 'too-long' }
  } catch {
    return null
  } finally {
    if (fd !== null) { try { io.closeSync(fd) } catch { /* already closed */ } }
  }
}
