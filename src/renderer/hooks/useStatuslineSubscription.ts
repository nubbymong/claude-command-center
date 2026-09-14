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
      // Claude live effort (statusline effort.level) -- updates on mid-session /effort.
      // Mark effortLive so the sidebar card can show the pill ONLY now that a real
      // statusline tick has confirmed the level (no spawn/persisted guess shown first).
      if (data.effortLevel) {
        updates.effortLevel = data.effortLevel
        updates.effortLive = true
      }
      // Claude live Fast Mode (statusline fast_mode) -- per-session, flips on
      // /fast. Copy both true and false so the card's bolt clears when toggled off.
      if (data.fastMode != null) updates.fastMode = data.fastMode
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
      // Dynamic usage buckets (limits[] discovery). Copy even when empty so a
      // bucket that disappeared upstream clears from the strip.
      if (data.usageBuckets) updates.usageBuckets = data.usageBuckets
      // v1.5.9: do NOT copy accountEmail / accountColour into the session
      // store FOR LOCAL SESSIONS. The local bridge reads
      // ~/.claude.json:oauthAccount which is a GLOBAL field -- every
      // per-session tick was clobbering the chip with whichever account was
      // logged in last; the spawn-time capture (useAccountIdentitySubscription)
      // is the drift-immune local source.
      //
      // Phase 3 (harmonise-remote): SSH sessions are the exception -- their
      // ticks arrive over the session's own tunnel from the REMOTE's
      // ~/.claude.json, which is exactly that session's signed-in account
      // (a remote /login shows up on the next tick; two sessions to the same
      // host+user genuinely share the account). The spawn-time capture never
      // covers remotes, so the tick is the live source here, superseding the
      // setup-sentinel snapshot (sshRemoteAccount) the render sites fall
      // back to.
      if (data.accountEmail) {
        const sess = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
        if (sess?.sessionType === 'ssh') {
          updates.accountEmail = data.accountEmail
          if (data.accountColour) updates.accountColour = data.accountColour
        }
      }
      if (Object.keys(updates).length > 0) {
        updateSession(sessionId, updates)
      }
    })
    return unsub
  }, [sessionId])
}
