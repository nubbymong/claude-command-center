// src/renderer/utils/accountChip.ts
//
// P3.6 (row 7's migration, row 20): what an account chip shows, from the
// account's identity.
//
// Claude's chips (the strip, the sidebar card, the session header, the launch
// picker and the Remote Resumable list) found their colour in the email-keyed
// overrides setting. The account list mirrors each Claude profile to an
// identity and carries that override into the identity's colour when it does
// (the reconcile's legacy snapshot: override, else the profile's own key, else
// the email's colour), and the identity editor keeps the override in step
// with the identity. So a chip that can name the identity reads its colour
// there, and one that cannot keeps the override path unchanged:
//   - no account list yet (it has not arrived, or cannot be read);
//   - a profile the list does not mirror yet (a partial registry);
//   - an email no profile has, or one that two profiles share (design 19: an
//     email-keyed value migrates only when the email resolves uniquely to
//     exactly one Claude profile; an ambiguous one never selects an account).
// Nothing here writes or removes an override. The setting stays exactly as it
// was, which is the way back: without the list, or after a downgrade, every
// chip reads it as before.
//
// The multi-account footer's plain Claude pill keeps its own approved rule
// (usage track MP5: a pill of Claude Code sessions alone takes its name and
// colour from the email, aliases and overrides included); the identity holds
// the same colour while the two are kept in step.
import type { AccountsSnapshot, AccountView, ProviderId } from '../../shared/providers'
import { isIdentityColourKey } from '../../shared/providers'
import type { IdentityColorKey } from '../../shared/identity-colors'
import type { AccountProfile } from '../../shared/account-types'
import { canonicaliseEmail, resolveAccountColourKey } from '../../shared/account-chip-color'

/** What a chip's colour is read from. */
export interface ChipSources {
  profiles: ReadonlyArray<Pick<AccountProfile, 'id' | 'accountEmail'>>
  snapshot: AccountsSnapshot | null
  /** The email-keyed Claude colour overrides (settings). */
  overrides: Record<string, IdentityColorKey> | undefined
}

/** The one Claude profile with this email; none when no profile, or more
 *  than one, has it. */
export function uniqueProfileForEmail<P extends Pick<AccountProfile, 'accountEmail'>>(email: string, profiles: ReadonlyArray<P>): P | undefined {
  const canon = canonicaliseEmail(email)
  if (!canon) return undefined
  const matches = profiles.filter((p) => typeof p.accountEmail === 'string' && p.accountEmail !== '' && canonicaliseEmail(p.accountEmail) === canon)
  return matches.length === 1 ? matches[0] : undefined
}

/** An account's identity colour, when the identity has one in the palette. */
export function identityColourOf(snapshot: AccountsSnapshot | null, account: Pick<AccountView, 'identityId'> | undefined): IdentityColorKey | undefined {
  if (!snapshot || !account) return undefined
  const identity = snapshot.identities.find((i) => i.id === account.identityId)
  return identity && isIdentityColourKey(identity.colourKey) ? (identity.colourKey as IdentityColorKey) : undefined
}

/** The registry account mirroring one of a provider's own accounts (a
 *  Claude profile), unless it is archived. */
function mirroredAccount(snapshot: AccountsSnapshot | null, providerId: ProviderId, legacyId: string): AccountView | undefined {
  return snapshot?.accounts.find((a) => a.providerId === providerId && a.legacyId === legacyId && a.lifecycle !== 'archived')
}

/** The identity colour of the Claude account mirroring this profile, or
 *  none (no list, or the profile is not mirrored). */
export function claudeProfileIdentityColour(profileId: string, snapshot: AccountsSnapshot | null): IdentityColorKey | undefined {
  return identityColourOf(snapshot, mirroredAccount(snapshot, 'claude', profileId))
}

/**
 * The colour KEY of a chip that names a Claude account by its email (the
 * session's live account, a remote session's reported one, a Remote
 * Resumable entry's): the identity of the one profile with that email, else
 * resolveAccountColourKey as before (the override, else `fallback`, else
 * mauve).
 */
export function chipColourKeyForEmail(email: string | undefined, sources: ChipSources, fallback: IdentityColorKey | undefined): IdentityColorKey {
  if (email) {
    const profile = uniqueProfileForEmail(email, sources.profiles)
    const fromIdentity = profile ? claudeProfileIdentityColour(profile.id, sources.snapshot) : undefined
    if (fromIdentity) return fromIdentity
  }
  return resolveAccountColourKey(email, sources.overrides, fallback)
}

/**
 * The colour KEY of a chip for a Claude profile known by its id (the launch
 * picker): that profile's own identity, else its override, else its own key,
 * else mauve (as before).
 */
export function chipColourKeyForProfile(
  profile: Pick<AccountProfile, 'id' | 'accountEmail' | 'colourKey'> | undefined,
  sources: Pick<ChipSources, 'snapshot' | 'overrides'>,
): IdentityColorKey {
  const fromIdentity = profile ? claudeProfileIdentityColour(profile.id, sources.snapshot) : undefined
  if (fromIdentity) return fromIdentity
  return resolveAccountColourKey(profile?.accountEmail, sources.overrides, profile?.colourKey)
}
