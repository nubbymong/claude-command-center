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
      if (data.reasoningEffort) updates.reasoningEffort = data.reasoningEffort
      // Claude live effort (statusline effort.level) -- updates on mid-session /effort
      if (data.effortLevel) updates.effortLevel = data.effortLevel
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
      // v1.5.9: do NOT copy accountEmail / accountColour into the session
      // store. The statusline bridge reads ~/.claude.json:oauthAccount which
      // is a GLOBAL field -- every per-session tick was clobbering the chip
      // with whichever account was logged in last. The chip is gone; the
      // ledger-side capture in tokenomics-manager remains (different concern).
      if (Object.keys(updates).length > 0) {
        updateSession(sessionId, updates)
      }
    })
    return unsub
  }, [sessionId])
}
