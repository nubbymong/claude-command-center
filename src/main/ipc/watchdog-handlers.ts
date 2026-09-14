// src/main/ipc/watchdog-handlers.ts
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { getWatchdogManager } from '../watchdog/watchdog-manager'
import type { WatchdogChecks, WatchdogPublicState } from '../watchdog/session-watchdog'

/** The three switchable checks, validated field by field. The renderer supplies
 *  this payload, and it decides whether the watchdog may type into a PTY, so
 *  nothing is trusted: a non-object, an unknown key, or a non-boolean value is
 *  dropped rather than coerced. An empty result is a no-op, never a reset. */
function sanitizeChecks(raw: unknown): Partial<WatchdogChecks> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const src = raw as Record<string, unknown>
  const out: Partial<WatchdogChecks> = {}
  for (const key of ['rateLimit', 'overload', 'safeguard'] as const) {
    if (typeof src[key] === 'boolean') out[key] = src[key]
  }
  return out
}

/**
 * Session Watchdog (#235) read surface. The state PUSH (IPC.WATCHDOG_STATE)
 * is sent directly from watchdog-manager's onStateChange adapter callback
 * (mirrors the statusline fan-out) — this handler only covers the renderer's
 * pull-on-mount hydration, so a tab opened after a watchdog already started
 * still shows its current state instead of nothing until the next change.
 */
export function registerWatchdogHandlers(): void {
  ipcMain.handle(IPC.WATCHDOG_GET_STATES, (): WatchdogPublicState[] => {
    return getWatchdogManager()?.getStates() ?? []
  })

  // #605: per-session, runtime-only. The sessionId selects an already-armed
  // entry (an unknown id is a no-op) and the payload carries booleans only, so
  // this cannot reach another session or smuggle a message in. It is NOT a
  // pure "types less" lever, though: switching a check back ON re-arms that
  // check. SessionWatchdog.parkedBudget is what stops that re-arming from
  // refunding a spent retry budget or resurrecting a give-up: the incident
  // resumes with the budget it had already used (ADR-009 rounds 1 and 2).
  ipcMain.handle(IPC.WATCHDOG_SET_CHECKS, (_evt, sessionId: unknown, checks: unknown): boolean => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false
    const clean = sanitizeChecks(checks)
    if (Object.keys(clean).length === 0) return false
    return getWatchdogManager()?.setSessionChecks(sessionId, clean) ?? false
  })
}
