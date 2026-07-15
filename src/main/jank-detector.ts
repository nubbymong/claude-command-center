// src/main/jank-detector.ts
// A self-rescheduling timer measures how late each tick is vs its scheduled
// interval. A large gap means the event loop was blocked (a freeze). Logs via
// logInfo so it is always captured.
import { logInfo } from './debug-logger'

const INTERVAL_MS = 250
const STALL_FACTOR = 4   // log when actual gap > 4x expected (>1s here)

export function reportIfStalled(actualGap: number, expected: number, log: (m: string) => void, label: string): void {
  if (actualGap > expected * STALL_FACTOR) {
    log(`[jank] main loop stalled ${Math.round(actualGap)}ms (expected ~${expected}ms) near ${label}`)
  }
}

let timer: ReturnType<typeof setTimeout> | null = null
let last = 0
export function startJankDetector(now: () => number = () => performance.now()): void {
  if (timer) return
  last = now()
  const tick = () => {
    const t = now()
    reportIfStalled(t - last, INTERVAL_MS, (m) => logInfo(m), 'tick')
    last = t
    timer = setTimeout(tick, INTERVAL_MS)
    timer.unref?.()
  }
  timer = setTimeout(tick, INTERVAL_MS)
  timer.unref?.()
}
