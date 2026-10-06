// Isolated module for PTY lifecycle tracking.
// Separated from TerminalView so that HMR of components doesn't reset the Set.
import { forgetSpawnEnd } from './utils/spawnEndNotice'

/** Session id -> the token of the spawn that started its current PTY. */
const spawnedPtys = new Map<string, number>()
let lastToken = 0

export function hasSpawned(sessionId: string): boolean {
  return spawnedPtys.has(sessionId)
}

/** Record that a spawn of `sessionId` is starting, and return its token. The
 *  token stays the session's current one until the tracker is cleared (an
 *  exit, a Restart, a close) or another spawn replaces it; a view that is
 *  merely remounted (a partner-terminal restart re-keys the main view) keeps
 *  it. */
export function markSpawned(sessionId: string): number {
  const token = ++lastToken
  spawnedPtys.set(sessionId, token)
  return token
}

/** Whether the spawn holding `token` is still this session's current one. */
export function isCurrentSpawn(sessionId: string, token: number | undefined): boolean {
  return token !== undefined && spawnedPtys.get(sessionId) === token
}

export function clearSpawned(sessionId: string): void {
  spawnedPtys.delete(sessionId)
}

export function killSessionPty(sessionId: string): void {
  spawnedPtys.delete(sessionId)
  // Closed, or restarted afresh: a start-ended report kept for a view that
  // never listened belongs to the run that is going (utils/spawnEndNotice).
  forgetSpawnEnd(sessionId)
  window.electronAPI.pty.kill(sessionId)
  // Also kill partner PTY if it was spawned
  const partnerId = sessionId + '-partner'
  if (spawnedPtys.has(partnerId)) {
    spawnedPtys.delete(partnerId)
    window.electronAPI.pty.kill(partnerId)
  }
}
