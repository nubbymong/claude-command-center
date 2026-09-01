/**
 * Per-session memory of the SSH auth shimmer's give-up.
 *
 * SshAuthPending (SessionHeader) is keyed by session.id, so switching away and
 * back to a chronically identity-less SSH session REMOUNTED it with a fresh
 * 20s give-up clock — the shimmer re-armed on every re-activation. This module
 * remembers, per session id, that the shimmer already ran its bound once, so a
 * remount renders the given-up fallback (blank / GitHub tail) immediately.
 *
 * Lifecycle: marked when the give-up timer fires; cleared when identity
 * ARRIVES (a session whose account lands late may shimmer afresh if identity
 * is later lost, e.g. across a reconnect) and when the session is removed
 * (sessionStore.removeSession). Identity-present always wins regardless of
 * this memory: the parent gate renders the real pills whenever an email or
 * mapped profile is known — this only decides shimmer-vs-blank while NOTHING
 * is known.
 *
 * Deliberately a module-level Set: component state cannot survive the keyed
 * remount (that remount IS the bug), and the Session record is persisted UI
 * truth, not the place for an ephemeral render bound.
 */
const gaveUpSessionIds = new Set<string>()

export const sshAuthGiveUpMemory = {
  has(sessionId: string): boolean {
    return gaveUpSessionIds.has(sessionId)
  },
  markGaveUp(sessionId: string): void {
    gaveUpSessionIds.add(sessionId)
  },
  clear(sessionId: string): void {
    gaveUpSessionIds.delete(sessionId)
  },
}

/** Test-only: wipe all per-session give-up memory. */
export function _resetSshAuthGiveUpForTest(): void {
  gaveUpSessionIds.clear()
}
