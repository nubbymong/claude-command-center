/**
 * Helpers for translating between bare sessionIds and the slotKey format that
 * listSlots synthesizes for orphan slots (those with no configId).
 *
 * Orphan slotKey format: `orphan:<sessionId>`
 * Config-keyed slotKey:  the configId itself
 */

/**
 * Strip the "orphan:" prefix that listSlots synthesizes onto an orphan slot's
 * slotKey, recovering the BARE sessionId the DB (runs.sessionId) and FTS hits
 * (hit.sessionId) actually carry. Non-orphan slotKeys pass through unchanged.
 */
export function orphanSessionId(slotKey: string): string {
  return slotKey.startsWith('orphan:') ? slotKey.slice('orphan:'.length) : slotKey
}

/**
 * Slot key for a session given its (possibly null) configId — the inverse of
 * the listSlots synthesis rule. Pass this to `slots.find(s => s.slotKey === key)`
 * to locate the owning slot for a bare sessionId.
 */
export function slotKeyForSession(sessionId: string, configId: string | null): string {
  return configId ?? `orphan:${sessionId}`
}
