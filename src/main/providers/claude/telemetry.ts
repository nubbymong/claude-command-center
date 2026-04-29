/**
 * Per-session Claude telemetry subscription (lifted from statusline-watcher.ts in P0.7).
 *
 * The actual filesystem watcher is a single global watcher in statusline-watcher.ts
 * (one fs.watch + poll covers all <resourcesDir>/status/*.json files). This module
 * exposes a per-session subscription API: a caller registers a callback for a given
 * session ID, and the global dispatcher routes matching updates here.
 *
 * The global dispatcher always sends every update to the renderer + tokenomics
 * (unchanged behaviour). Per-session subscribers are an additional fan-out for
 * provider-aware consumers that want a typed StatuslineData stream scoped to one session.
 */
import type { StatuslineData } from '../../../shared/types'
import type { TelemetrySource } from '../types'

type Listener = (data: StatuslineData) => void

const listeners = new Map<string, Set<Listener>>()

/**
 * Internal: called by the global statusline dispatcher (statusline-watcher.ts and
 * pty-manager's SSH OSC sentinel parser) for every parsed StatuslineData payload.
 * Routes to per-session subscribers registered via watchClaudeStatuslineFile().
 */
export function notifyClaudeTelemetry(data: StatuslineData): void {
  if (!data || !data.sessionId) return
  const set = listeners.get(data.sessionId)
  if (!set || set.size === 0) return
  for (const cb of set) {
    try { cb(data) } catch { /* ignore subscriber errors */ }
  }
}

/**
 * Subscribe to statusline updates for a specific session. The returned
 * TelemetrySource's stop() unregisters the callback.
 *
 * The underlying watcher is a single global fs.watch+poll started by
 * startStatuslineWatcher() at app boot — this function does NOT start a new
 * filesystem watcher per session.
 */
export function watchClaudeStatuslineFile(
  sessionId: string,
  onUpdate: (data: StatuslineData) => void
): TelemetrySource {
  let set = listeners.get(sessionId)
  if (!set) {
    set = new Set()
    listeners.set(sessionId, set)
  }
  set.add(onUpdate)

  return {
    stop(): void {
      const s = listeners.get(sessionId)
      if (!s) return
      s.delete(onUpdate)
      if (s.size === 0) listeners.delete(sessionId)
    },
  }
}
