import type { AccountProfile } from '../../shared/account-types'
import { canonicaliseEmail } from '../../shared/account-chip-color'

export interface NameableAccount {
  email: string
  profileId?: string        // present => rename via profile; absent => rename via alias map
  currentName: string       // profile.name, else alias, else '' (empty = unnamed)
}

/**
 * Union of profile accounts + distinct session emails not covered by a profile.
 *
 * One entry per profile (email = profile.accountEmail, profileId = profile.id,
 * currentName = profile.name), followed by one entry per distinct canonical
 * session email NOT equal to any profile's canonical email (profileId =
 * undefined, currentName = aliases?.[canonical] ?? ''). De-duped by canonical
 * email; profile entries win over session-only entries. Stable order: profiles
 * first (input order), then session-only emails sorted by canonical form.
 */
export function buildNameableAccounts(
  profiles: AccountProfile[],
  sessionEmails: string[],
  aliases: Record<string, string> | undefined,
): NameableAccount[] {
  const out: NameableAccount[] = []
  const seen = new Set<string>()

  // Profiles first, in input order. Their canonical email claims the slot so a
  // matching session email never produces a duplicate row.
  for (const p of profiles) {
    const canonical = canonicaliseEmail(p.accountEmail)
    if (seen.has(canonical)) continue
    seen.add(canonical)
    out.push({ email: p.accountEmail, profileId: p.id, currentName: p.name })
  }

  // Distinct session-only emails (canonical), sorted for stable order. Skip
  // blanks and any email already covered by a profile.
  const sessionOnly: { email: string; canonical: string }[] = []
  for (const raw of sessionEmails) {
    const canonical = canonicaliseEmail(raw ?? '')
    if (!canonical) continue
    if (seen.has(canonical)) continue
    seen.add(canonical)
    sessionOnly.push({ email: raw.trim(), canonical })
  }
  sessionOnly.sort((a, b) => a.canonical.localeCompare(b.canonical))

  for (const { email, canonical } of sessionOnly) {
    out.push({ email, profileId: undefined, currentName: aliases?.[canonical] ?? '' })
  }

  return out
}
