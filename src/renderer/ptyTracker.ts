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

/** The token of the spawn that started the session's current PTY, if any
 *  (P3.8 round 1: a typed command's Enter goes only to the run it was typed
 *  into). */
export function currentSpawnToken(sessionId: string): number | undefined {
  return spawnedPtys.get(sessionId)
}

/** Whether the spawn holding `token` is still this session's current one. */
export function isCurrentSpawn(sessionId: string, token: number | undefined): boolean {
  return token !== undefined && spawnedPtys.get(sessionId) === token
}

export function clearSpawned(sessionId: string): void {
  spawnedPtys.delete(sessionId)
}

/** `restart`: a Restart ends the session's processes (their next ones
 *  follow, the hidden one when its view is shown), so main does not take
 *  their exits as the session's end (P3.16a round 2, Q5). Absent: a close. */
export function killSessionPty(sessionId: string, opts: { restart?: boolean } = {}): void {
  spawnedPtys.delete(sessionId)
  // Closed, or restarted afresh: a start-ended report kept for a view that
  // never listened belongs to the run that is going (utils/spawnEndNotice).
  forgetSpawnEnd(sessionId)
  const kill = (id: string) => (opts.restart ? window.electronAPI.pty.kill(id, 'restart') : window.electronAPI.pty.kill(id))
  kill(sessionId)
  // Also kill the partner PTY: a Restart only one that was spawned; a close
  // always, so main ends the partner's record too when a Restart ended its
  // process and its view was not shown again (fixer 3, F1).
  const partnerId = sessionId + '-partner'
  if (spawnedPtys.has(partnerId) || !opts.restart) {
    spawnedPtys.delete(partnerId)
    kill(partnerId)
  }
}
