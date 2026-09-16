import { readCodexAccountEmail } from './account-identity'
import type { AccountIdentity } from '../shared/types'

/**
 * P8.8: per-session Codex spawn-time identity. Captured at PTY spawn,
 * read by tokenomics applyIdentityAtFlush() so claim-time drift on
 * ~/.codex/auth.json doesn't misattribute tokens.
 */
const codexSpawnIdentity = new Map<string, AccountIdentity>()

export function captureCodexSpawnIdentity(sessionId: string): void {
  const id = readCodexAccountEmail()
  if (id) codexSpawnIdentity.set(sessionId, id)
}

export function clearCodexSpawnIdentity(sessionId: string): void {
  codexSpawnIdentity.delete(sessionId)
}

export function getCodexSpawnIdentityMap(): Map<string, AccountIdentity> {
  return codexSpawnIdentity
}
