/**
 * pty-chunked-write.ts — the pure, dependency-free core of pty-manager's large-
 * paste chunking loop, extracted so it can be unit-tested without the full
 * pty-manager dependency graph (electron / node-pty / hooks / ...).
 *
 * R-010: a large paste is chunked at WRITE_CHUNK_SIZE bytes every
 * WRITE_CHUNK_DELAY ms, so a 50KB paste spans ~2.4s — long enough to race a
 * session kill / in-session Restart / app-quit. Each chunk must therefore:
 *   1. re-check that the destination PTY is STILL the live one for the session
 *      (a respawn replaces it under the same sessionId), and bail if not; and
 *   2. wrap the write in try/catch so a write to a destroyed stream
 *      (ERR_STREAM_DESTROYED — NOT EPIPE/EIO) cannot throw out of the timer
 *      callback, which the global uncaughtException handler re-throws → main
 *      process crash.
 *
 * No default export (project convention).
 */

/** Chunk-size + inter-chunk delay (ms). Shared with pty-manager's constants. */
export const WRITE_CHUNK_SIZE = 256
export const WRITE_CHUNK_DELAY = 12

export interface ChunkedWriteHooks {
  /** Write one slice to the PTY. May throw if the PTY is dead. */
  write: (slice: string) => void
  /** True while THIS write's target PTY is still the live, registered one. */
  isAlive: () => boolean
  /** Schedule the next chunk (defaults to setTimeout). Injectable for tests. */
  schedule?: (fn: () => void, delayMs: number) => void
  /** Chunk size override (tests). */
  chunkSize?: number
  /** Inter-chunk delay override (tests). */
  delayMs?: number
}

/**
 * Drive a liveness-guarded, crash-safe chunked write of `data`. Returns
 * immediately after kicking off the first chunk; subsequent chunks are driven by
 * `schedule`. Stops (without throwing) the moment `isAlive()` is false or a write
 * throws — the remaining bytes are dropped rather than risk an uncaught throw.
 */
export function runChunkedWrite(data: string, hooks: ChunkedWriteHooks): void {
  const size = hooks.chunkSize ?? WRITE_CHUNK_SIZE
  const delay = hooks.delayMs ?? WRITE_CHUNK_DELAY
  const schedule = hooks.schedule ?? ((fn, ms) => { setTimeout(fn, ms) })
  let offset = 0
  const writeNext = (): void => {
    if (offset >= data.length) return
    // Liveness: bail if the session is gone or its PTY was replaced by a respawn.
    if (!hooks.isAlive()) return
    const end = Math.min(offset + size, data.length)
    try {
      hooks.write(data.slice(offset, end))
    } catch {
      return // session died mid-paste; drop the rest rather than crash main
    }
    offset = end
    if (offset < data.length) {
      schedule(writeNext, delay)
    }
  }
  writeNext()
}
