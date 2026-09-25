// Claude's legacy account store as a registry port (WP2, design 6.1, 6.4).
// profiles.json stays Claude's source of truth in 2.1.1; the neutral registry
// mirrors it through this port and writes its own edits back here.
//
// Read: profiles.json and the email colour overrides in settings, both read
// STRICTLY -- a file that exists but cannot be read makes the whole snapshot
// null, which the registry treats as "unreadable, change nothing", never as
// "no accounts". Write: the name and the active flag go to profiles.json; a
// colour goes to the profile's own key only for a profile with no email. A
// profile with an email takes its colour from the email-keyed override that
// every chip reads, and that setting is owned by the renderer, so those
// writes stay pending here until the renderer applies them.
import { isAccountActive } from '../../../shared/account-types'
import type { AccountProfile } from '../../../shared/account-types'
import type { IdentityColorKey } from '../../../shared/identity-colors'
import { isValidProfileId } from '../../../shared/profile-id'
import { isIdentityColourKey, normaliseLabel, FRIENDLY_NAME_MAX } from '../../../shared/providers'
import type { LegacyWrite } from '../../../shared/providers'
import type { LegacyAccountsPort } from '../core'
import { claudeLegacySnapshot } from './legacy-accounts'

/** The main-process stores this port reads and writes, injected by the
 *  composition root so the package itself imports no shared main module (a
 *  shared module here would reach the other package: rule R2). */
export interface ClaudeLegacyAccountsIo {
  /** profiles.json strictly: [] when absent, null when unreadable. */
  readProfiles(): AccountProfile[] | null
  /** Edit the profile objects of profiles.json in place, only when it read
   *  completely; `edit` returns whether it changed any. False when unreadable. */
  updateProfiles(edit: (profiles: AccountProfile[]) => boolean): boolean
  /** settings.json, read WITHOUT quarantining an unparseable file. */
  readSettings(): { outcome: string; value: unknown }
}

/** The override map, undefined when settings has none, null when settings
 *  exists but could not be read. */
function readColourOverrides(io: ClaudeLegacyAccountsIo): Record<string, IdentityColorKey> | undefined | null {
  const r = io.readSettings()
  if (r.outcome === 'absent') return undefined
  if (r.outcome !== 'ok') return null
  const o = (r.value as { accountColourOverrides?: unknown } | null)?.accountColourOverrides
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, IdentityColorKey>) : undefined
}

const hasEmail = (email: unknown) => typeof email === 'string' && email.trim().length > 0

export function createClaudeLegacyAccountsPort(io: ClaudeLegacyAccountsIo): LegacyAccountsPort {
  return {
    providerId: 'claude',
    read() {
      const profiles = io.readProfiles()
      if (!profiles) return null
      const overrides = readColourOverrides(io)
      if (overrides === null) return null
      return claudeLegacySnapshot(profiles, overrides)
    },
    apply(writes: readonly LegacyWrite[]) {
      const mine = writes.filter((w) => w.providerId === 'claude')
      if (!mine.length) return
      const read = io.updateProfiles((objects) => {
        // Only real profile records count -- for finding the target and for
        // "another active account" -- never a hand-edited stray entry.
        const all = objects.filter((x) => isValidProfileId(x.id))
        let changed = false
        for (const w of mine) {
          const p = all.find((x) => x.id === w.legacyId)
          if (!p) continue
          if (w.field === 'friendlyName') {
            // Re-normalised here too: whatever produced the write, only a
            // stored-form name (bounded, nothing invisible) reaches the file.
            const name = normaliseLabel(w.value, FRIENDLY_NAME_MAX)
            if (name && p.name !== name) { p.name = name; changed = true }
          } else if (w.field === 'lifecycle') {
            const active = w.value === 'active'
            if (isAccountActive(p) === active) continue
            // The rules the Claude surfaces enforce: the primary is always
            // active, and the last active account stays active.
            if (!active && (p.isPrimary || !all.some((x) => x.id !== p.id && isAccountActive(x)))) continue
            p.active = active
            changed = true
          } else if (w.field === 'colourKey') {
            if (hasEmail(p.accountEmail) || !isIdentityColourKey(w.value)) continue
            if (p.colourKey !== w.value) { p.colourKey = w.value as IdentityColorKey; changed = true }
          }
        }
        return changed
      })
      if (!read) throw new Error('profiles.json could not be read completely; nothing was written')
    },
  }
}
