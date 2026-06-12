/**
 * loop-stall-monitor.ts — a process-local event-loop "jank" monitor.
 *
 * A self-rescheduling 500ms ticker measures how late each tick fires versus its
 * scheduled interval. A tick arriving more than LATE_THRESHOLD_MS (250ms) after
 * it was due means the event loop was blocked for at least that long — one stall
 * sample. We keep a rolling 60s window of stall timestamps and expose the count
 * within that window as `stallsLastMin()`.
 *
 * This is the MAIN-process counterpart to the hooks child's own monitor (the
 * "Jank m/c" pill renders main/child). Both sides use the SAME thresholds:
 * 500ms tick interval, >250ms lateness = one stall, 60s window. (The repo's
 * older jank-detector.ts logs at a 250ms interval / 4x factor for a different
 * purpose — a console freeze warning — and is left untouched.)
 *
 * Designed as a singleton with start()/stop()/stallsLastMin() so index.ts can
 * own one instance, and so the child host can reuse the same Monitor class.
 * Injectable clock + scheduler make it deterministic under fake timers.
 */

export const TICK_INTERVAL_MS = 500
export const LATE_THRESHOLD_MS = 250
export const WINDOW_MS = 60_000

type TimerHandle = ReturnType<typeof setTimeout>

export interface LoopStallMonitorOptions {
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => TimerHandle
  clearTimer?: (h: TimerHandle) => void
}

/** Reusable instance — index.ts uses the module singleton below; the hooks child
 *  constructs its own so both halves of the "Jank m/c" metric share one impl. */
export class LoopStallMonitor {
  private now: () => number
  private setTimer: (cb: () => void, ms: number) => TimerHandle
  private clearTimer: (h: TimerHandle) => void
  private timer: TimerHandle | null = null
  private last = 0
  // Timestamps (ms) of stall samples, kept in arrival order so old entries can be
  // dropped from the front once they age out of the rolling window.
  private stalls: number[] = []

  constructor(opts: LoopStallMonitorOptions = {}) {
    this.now = opts.now ?? (() => Date.now())
    this.setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h))
  }

  start(): void {
    if (this.timer !== null) return
    this.last = this.now()
    this.schedule()
  }

  stop(): void {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null }
  }

  /** Number of stall samples observed within the last WINDOW_MS. */
  stallsLastMin(): number {
    this.prune(this.now())
    return this.stalls.length
  }

  private schedule(): void {
    this.timer = this.setTimer(() => this.tick(), TICK_INTERVAL_MS)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  private tick(): void {
    const t = this.now()
    const lateness = (t - this.last) - TICK_INTERVAL_MS
    if (lateness > LATE_THRESHOLD_MS) this.stalls.push(t)
    this.prune(t)
    this.last = t
    this.schedule()
  }

  /** Drop stall timestamps older than the rolling window. */
  private prune(now: number): void {
    const cutoff = now - WINDOW_MS
    let drop = 0
    while (drop < this.stalls.length && this.stalls[drop] <= cutoff) drop++
    if (drop > 0) this.stalls.splice(0, drop)
  }
}

// --- Module singleton (main process) -----------------------------------------
let singleton: LoopStallMonitor | null = null

export function start(): void {
  if (!singleton) singleton = new LoopStallMonitor()
  singleton.start()
}

export function stop(): void {
  singleton?.stop()
}

export function stallsLastMin(): number {
  return singleton ? singleton.stallsLastMin() : 0
}
