// Isolated module for PTY lifecycle tracking.
// Separated from TerminalView so that HMR of components doesn't reset the Set.

const spawnedPtys = new Set<string>()

export function hasSpawned(sessionId: string): boolean {
  return spawnedPtys.has(sessionId)
}

export function markSpawned(sessionId: string): void {
  spawnedPtys.add(sessionId)
}

export function killSessionPty(sessionId: string): void {
  spawnedPtys.delete(sessionId)
  window.electronAPI.pty.kill(sessionId)
  // Also kill partner PTY if it was spawned
  const partnerId = sessionId + '-partner'
  if (spawnedPtys.has(partnerId)) {
    spawnedPtys.delete(partnerId)
    window.electronAPI.pty.kill(partnerId)
  }
}
