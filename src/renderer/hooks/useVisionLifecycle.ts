import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'

interface VisionConfig {
  enabled: boolean
  browser: 'chrome' | 'edge'
  debugPort: number
  url?: string
}

/**
 * Subscribe to vision status changes and clean up on unmount.
 * Vision is started in pty:spawn (before PTY) so env vars are available.
 */
export function useVisionLifecycle(sessionId: string, visionConfig?: VisionConfig) {
  const updateSession = useSessionStore((s) => s.updateSession)

  useEffect(() => {
    if (!visionConfig?.enabled) return

    const unsub = window.electronAPI.vision.onStatusChanged((data) => {
      if (data.sessionId !== sessionId) return
      updateSession(sessionId, { visionConnected: data.connected, visionPort: data.proxyPort })
    })

    return () => {
      unsub()
      window.electronAPI.vision.stop(sessionId)
      updateSession(sessionId, { visionConnected: undefined, visionPort: undefined })
    }
  }, [sessionId, visionConfig?.enabled])
}
