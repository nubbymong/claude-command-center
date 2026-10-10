// src/main/jank-detector.ts
// A self-rescheduling timer measures how late each tick is vs its scheduled
// interval. A large gap means the event loop was blocked (a freeze). Logs via
// logInfo so it is always captured. ADR-025: the line names the tracked
// main-thread operation in flight during the stall (main-thread-ops.ts), or
// says that none was, rather than a constant label.
import { logInfo } from './debug-logger'
import { mainThreadOpSince } from './main-thread-ops'

const INTERVAL_MS = 250
const STALL_FACTOR = 4   // log when actual gap > 4x expected (>1s here)

export function reportIfStalled(actualGap: number, expected: number, log: (m: string) => void, label: string): void {
  if (actualGap > expected * STALL_FACTOR) {
    log(`[jank] main loop stalled ${Math.round(actualGap)}ms (expected ~${expected}ms) near ${label}`)
  }
}

/** What a stall that began after `since` is near: the tracked main-thread
 *  operation in flight then, else the tick itself, said to have none. */
export function jankLabel(since: number): string {
  return mainThreadOpSince(since) ?? 'tick (no tracked app operation in flight)'
}

let timer: ReturnType<typeof setTimeout> | null = null
let last = 0
export function startJankDetector(now: () => number = () => performance.now()): void {
  if (timer) return
  last = now()
  const tick = () => {
    const t = now()
    reportIfStalled(t - last, INTERVAL_MS, (m) => logInfo(m), jankLabel(last))
    last = t
    timer = setTimeout(tick, INTERVAL_MS)
    timer.unref?.()
  }
  timer = setTimeout(tick, INTERVAL_MS)
  timer.unref?.()
}

/** Test-only: stop the detector so a suite can start it again. */
export function _stopJankDetectorForTest(): void {
  if (timer) clearTimeout(timer)
  timer = null
}
