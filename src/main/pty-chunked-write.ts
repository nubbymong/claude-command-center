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
  /** Called exactly once when the write finishes — all bytes sent, the session
   *  bailed (isAlive false), or a write threw. Lets a caller resolve a Promise
   *  (e.g. PasteQueue's envelope writer). No-op for callers that don't pass it. */
  onDone?: () => void
  /**
   * #242 tier 4: called after EVERY successful chunk write with the
   * cumulative byte count actually written so far and the total. Lets a
   * caller surface progress (pty-manager forwards it to
   * emitSshFlowState('running-setup', 'staging tmux NN%') for the ~1.27 MB
   * tmux-push transfer, with zero new IPC channels) without this module
   * knowing anything about SSH flow state. Monotonically non-decreasing,
   * ending at `data.length` on a full, successful write — NOT called on a
   * liveness bail or a throwing write, since `offset` only advances on a
   * write that actually succeeded (reporting progress for bytes that were
   * never delivered would be a lie the caller has no way to detect).
   *
   * #242 round-3 MINOR fix: this call is itself wrapped in a try/catch
   * inside `runChunkedWrite` (a throwing hook must not abort the write or
   * escape the setTimeout callback — see the module doc comment at the top
   * of this file for why that matters). Today's only caller
   * (pty-manager's `emitSshFlowState` wrapper) already swallows internally,
   * but a hook that can throw and take the whole write down with it would
   * be exactly the hazard this module exists to prevent, so the guard lives
   * here rather than trusting every future caller to add its own.
   */
  onProgress?: (bytesSent: number, totalBytes: number) => void
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
  const total = data.length
  let offset = 0
  let finished = false
  const done = (): void => { if (!finished) { finished = true; hooks.onDone?.() } }
  const writeNext = (): void => {
    if (offset >= data.length) return done()
    // Liveness: bail if the session is gone or its PTY was replaced by a respawn.
    if (!hooks.isAlive()) return done()
    const end = Math.min(offset + size, data.length)
    try {
      hooks.write(data.slice(offset, end))
    } catch {
      return done() // session died mid-paste; drop the rest rather than crash main
    }
    offset = end
    // #242 round-3 MINOR fix: a throwing onProgress hook must not propagate
    // out of this setTimeout-driven callback -- same reasoning as the
    // hooks.write try/catch just above (see the module doc comment): the
    // global uncaughtException handler re-throws anything that isn't
    // EPIPE/EIO, crashing main. onProgress is a caller-supplied hook with no
    // control over what it does; a progress hook must never be able to
    // abort the write it's merely observing.
    try {
      hooks.onProgress?.(offset, total)
    } catch { /* a progress hook must never abort the write */ }
    if (offset < data.length) {
      schedule(writeNext, delay)
    } else {
      done()
    }
  }
  writeNext()
}
