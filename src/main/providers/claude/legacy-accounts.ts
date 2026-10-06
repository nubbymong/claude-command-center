// Claude's legacy account store (profiles.json) as the provider-neutral
// registry sees it (WP2, design 6.1, 6.2). PURE: the caller reads the profile
// records and the email colour overrides and passes them in as values; this
// module only maps them, the way the existing Claude surfaces already show
// them, so a migrated identity looks exactly like the account it came from.
import type { AccountProfile } from '../../../shared/account-types'
import { isAccountActive } from '../../../shared/account-types'
import { canonicaliseEmail } from '../../../shared/account-chip-color'
import type { IdentityColorKey } from '../../../shared/identity-colors'
import { isValidProfileId } from '../../../shared/profile-id'
import { isIdentityColourKey, CLAUDE_PROFILE_PATH_REF_PREFIX } from '../../../shared/providers'
import type { LegacyAccountSnapshot } from '../../../shared/providers'
import { colourForEmail } from '../../account-color'

/** The realm reference a Claude profile's home resolves from. Only the Claude
 *  package turns it into a path, in the main process. */
export function claudeProfilePathRef(profileId: string): string {
  return `${CLAUDE_PROFILE_PATH_REF_PREFIX}${profileId}`
}

/** An own, palette-valid entry of the email-keyed override map. The map is
 *  JSON from settings: a plain index would find `constructor` on any object. */
function ownOverride(overrides: Record<string, IdentityColorKey> | undefined, email: string): IdentityColorKey | undefined {
  if (!overrides) return undefined
  const key = canonicaliseEmail(email)
  if (!Object.prototype.hasOwnProperty.call(overrides, key)) return undefined
  const v = overrides[key]
  return isIdentityColourKey(v) ? v : undefined
}

/** One snapshot record per profile with a valid id, in profiles.json order:
 *  - name: the profile name;
 *  - colour: the email override, else the profile's own key, else the colour
 *    every session chip shows for that email (colourForEmail), else mauve;
 *  - active: isAccountActive, so a primary is always active;
 *  - default: the primary profile, read as truthy exactly as
 *    getPrimaryProfileId and isAccountActive read it;
 *  - label: the account email, when setup has recorded one.
 *  A record whose id is not a valid profile id is not one this app wrote and
 *  is never migrated. */
export function claudeLegacySnapshot(
  profiles: readonly AccountProfile[],
  colourOverrides: Record<string, IdentityColorKey> | undefined,
): LegacyAccountSnapshot[] {
  const out: LegacyAccountSnapshot[] = []
  for (const p of profiles) {
    if (!p || typeof p !== 'object' || !isValidProfileId(p.id)) continue
    const email = typeof p.accountEmail === 'string' && p.accountEmail.trim() ? p.accountEmail : undefined
    const own = isIdentityColourKey(p.colourKey) ? p.colourKey : undefined
    // The precedence of resolveAccountColourKey, with an own-property lookup.
    const colourKey = (email ? ownOverride(colourOverrides, email) : undefined) ?? own ?? (email ? colourForEmail(email) : undefined) ?? 'mauve'
    out.push({
      legacyId: p.id,
      friendlyName: typeof p.name === 'string' ? p.name : '',
      colourKey,
      lifecycle: isAccountActive(p) ? 'active' : 'inactive',
      isDefault: Boolean(p.isPrimary),
      providerLabel: email,
      createdAt: typeof p.createdAt === 'number' ? p.createdAt : undefined,
      realm: { kind: 'claude-config-home', ownership: 'conductor-managed', pathRef: claudeProfilePathRef(p.id) },
      authMethod: 'browser',
      identityAssurance: 'user-asserted',
    })
  }
  return out
}
