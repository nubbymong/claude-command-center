import { useEffect, useState } from 'react'

// Module-level cache: the build mode never changes at runtime, so resolve the
// IPC once and share it across every consumer (no repeated round-trips).
let cached: boolean | null = null

/**
 * True when this is a dev build (npm run dev / ccc), false for a packaged prod
 * install. Drives DEV window labeling (badge + accent). Resolves via a one-shot
 * IPC and caches the result; returns false until the first resolve completes.
 */
export function useIsDev(): boolean {
  const [isDev, setIsDev] = useState(cached ?? false)
  useEffect(() => {
    if (cached !== null) { setIsDev(cached); return }
    let active = true
    window.electronAPI?.appIsDev?.()
      .then((v) => { cached = !!v; if (active) setIsDev(!!v) })
      .catch(() => { /* preload/main unavailable — treat as prod */ })
    return () => { active = false }
  }, [])
  return isDev
}
