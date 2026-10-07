import { useEffect, useState } from 'react'

/**
 * Re-renders every `ms` while mounted, so text a component computes from the
 * clock at render time (an age such as "Updated 2 min ago") moves on while
 * nothing else changes. The caller keeps reading Date.now() at render time,
 * so a render for any other reason (useRenderAtNextReset's included) is never
 * behind the clock.
 */
export function useRenderEvery(ms: number): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), ms)
    return () => clearInterval(timer)
  }, [ms])
}
