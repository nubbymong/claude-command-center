import { useEffect, useState } from 'react'

/** The longest a browser timer may wait. */
const MAX_TIMER_MS = 2_147_483_647

/**
 * Re-renders once the soonest reset among `resets` (ISO times) has passed, so
 * a usage window that resets while it is on screen turns to "no reading
 * since" (D2 of the usage UX) without waiting for other data to change. One
 * timer at a time; it moves on to the next reset after each.
 */
export function useRenderAtNextReset(resets: readonly string[]): void {
  const [tick, setTick] = useState(0)
  const key = resets.join('\n')
  useEffect(() => {
    const now = Date.now()
    let next = Infinity
    for (const r of key ? key.split('\n') : []) {
      const t = Date.parse(r)
      if (Number.isFinite(t) && t > now && t < next) next = t
    }
    if (!Number.isFinite(next)) return
    const timer = setTimeout(() => setTick((n) => n + 1), Math.min(next - now + 50, MAX_TIMER_MS))
    return () => clearTimeout(timer)
  }, [key, tick])
}
