// What the main thread was doing when it stalled (ADR-025).
//
// A synchronous program start (Node's spawn and execFile, node-pty's spawn)
// holds the main thread for as long as the start call takes; on Windows the
// first start of a newly written program can take seconds while the OS checks
// it. timedStart times such a start, logs one over SLOW_START_MS by the
// program's base name only ("[spawn] claude.exe took 1907 ms to start"; never
// its folder, arguments or environment), and records it, so the jank detector
// (jank-detector.ts) can name the operation in flight during a stall instead
// of a constant label. Only the starts wrapped here are tracked: a stall with
// none of them in flight is reported as such, which classes it as other work
// (another synchronous call, or the browser side's own work), not as nothing.
import { logInfo } from './debug-logger'

/** A start that held the main thread longer than this is logged. */
export const SLOW_START_MS = 500

/** The ops kept for the detector's next look: enough for one stall window. */
const KEEP = 16

interface Op { label: string; startedAt: number; endedAt: number | null }

let clock: () => number = () => performance.now()
const ops: Op[] = []

/** The program's last path part (either slash), control characters dropped,
 *  at most 80 characters: a log line names the program, nothing else. */
export function programBaseName(program: string): string {
  const last = String(program ?? '').split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  return last.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80) || 'a program'
}

/** Marks a main-thread operation as begun; the returned function ends it. */
export function noteMainThreadOp(label: string): () => void {
  const op: Op = { label, startedAt: clock(), endedAt: null }
  ops.push(op)
  if (ops.length > KEEP) ops.splice(0, ops.length - KEEP)
  let ended = false
  return () => {
    if (ended) return
    ended = true
    op.endedAt = clock()
  }
}

/** The tracked operation that ran on the main thread at any time after
 *  `since` (still running, or ended after it), the longest if several did;
 *  null when none did. On the detector's clock (performance.now()). */
export function mainThreadOpSince(since: number): string | null {
  let best: Op | null = null
  let bestMs = -1
  const now = clock()
  for (const op of ops) {
    const end = op.endedAt ?? now
    if (end <= since) continue
    const ms = end - Math.max(op.startedAt, since)
    if (ms > bestMs) { best = op; bestMs = ms }
  }
  return best ? best.label : null
}

/** Runs `start` (a synchronous program start), timing it on the main thread.
 *  Returns what it returns; an error it throws goes on to the caller. */
export function timedStart<T>(program: string, start: () => T): T {
  const name = programBaseName(program)
  const end = noteMainThreadOp(`start of ${name}`)
  const t0 = clock()
  try {
    return start()
  } finally {
    const ms = clock() - t0
    end()
    if (ms > SLOW_START_MS) {
      try { logInfo(`[spawn] ${name} took ${Math.round(ms)} ms to start`) } catch { /* logging never breaks a start */ }
    }
  }
}

/** Test-only: the clock the detector and the ops share. */
export function _setMainThreadClockForTest(now: () => number): void {
  clock = now
}

/** Test-only: forget every op and restore the real clock. */
export function _resetMainThreadOpsForTest(): void {
  ops.length = 0
  clock = () => performance.now()
}
