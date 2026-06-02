// src/main/first-run-accounts.ts
// Startup orchestration: migrate existing profiles to the canonical layout, then
// guarantee a captured, isolated "primary" account exists so no session ever runs
// on the bare global ~/.claude login (which a /login could otherwise clobber).
import {
  listProfiles, captureGlobalLogin, migrateProfilesToCanonicalLayout,
  getPrimaryProfileId, setPrimaryProfile, readCanonicalIdentityEmail,
} from './account-profiles'
import { getDefaultAccountEmail } from './claude-account-identity'
import { canonicaliseEmail } from '../shared/account-chip-color'

/** Pure decision for tests: capture only when there is no primary yet AND a
 *  global login exists to capture. */
export function decideFirstRunCapture(s: { hasPrimary: boolean; hasGlobalLogin: boolean }): 'capture' | 'none' {
  if (s.hasPrimary) return 'none'
  return s.hasGlobalLogin ? 'capture' : 'none'
}

/** Run once at startup (after config + setup are ready). Idempotent. */
export function runFirstRunCapture(): void {
  migrateProfilesToCanonicalLayout()
  if (getPrimaryProfileId()) return
  const globalEmail = getDefaultAccountEmail()
  if (!globalEmail) return // fresh, not yet logged in: capture happens after /login (later task)
  // If a profile already IS this account, just promote it to primary (no duplicate).
  // Fall back to the canonical identity email in case metadata email is blank (e.g. after migration).
  const existing = listProfiles().find((p) => {
    const email = p.accountEmail || readCanonicalIdentityEmail(p.id)
    return email != null && email !== '' && canonicaliseEmail(email) === canonicaliseEmail(globalEmail)
  })
  if (existing) { setPrimaryProfile(existing.id); return }
  const captured = captureGlobalLogin()
  if (captured) setPrimaryProfile(captured.id)
}
