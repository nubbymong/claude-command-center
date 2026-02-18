import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'

/**
 * Subscribe to statusline API updates for a session.
 * Updates session store with context, cost, model, rate limit, etc.
 */
export function useStatuslineSubscription(sessionId: string) {
  const updateSession = useSessionStore((s) => s.updateSession)

  useEffect(() => {
    const unsub = window.electronAPI.statusline.onUpdate((data) => {
      if (data.sessionId !== sessionId) return
      const updates: Record<string, unknown> = {}
      if (data.contextUsedPercent != null) updates.contextPercent = data.contextUsedPercent
      if (data.costUsd != null) updates.costUsd = data.costUsd
      if (data.model) updates.modelName = data.model
      if (data.linesAdded != null) updates.linesAdded = data.linesAdded
      if (data.linesRemoved != null) updates.linesRemoved = data.linesRemoved
      if (data.contextWindowSize != null) updates.contextWindowSize = data.contextWindowSize
      if (data.inputTokens != null) updates.inputTokens = data.inputTokens
      if (data.outputTokens != null) updates.outputTokens = data.outputTokens
      if (data.totalDurationMs != null) updates.totalDurationMs = data.totalDurationMs
      if (data.rateLimitCurrent != null) updates.rateLimitCurrent = data.rateLimitCurrent
      if (data.rateLimitCurrentResets) updates.rateLimitCurrentResets = data.rateLimitCurrentResets
      if (data.rateLimitWeekly != null) updates.rateLimitWeekly = data.rateLimitWeekly
      if (data.rateLimitWeeklyResets) updates.rateLimitWeeklyResets = data.rateLimitWeeklyResets
      if (data.rateLimitExtra) updates.rateLimitExtra = data.rateLimitExtra
      if (Object.keys(updates).length > 0) {
        updateSession(sessionId, updates)
      }
    })
    return unsub
  }, [sessionId])
}
