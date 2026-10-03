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
 * The registry account a session of an account-attributed provider (one
 * whose sessions each run under a registry account: Codex) runs under: the
 * one it names, else that provider's default. The rule the footer and the
 * strip's billing line read (usage track MP5, MP6). Never an account of
 * another provider, nor an archived default.
 */
export function sessionProviderAccount(
  session: { provider?: ProviderId; providerAccountId?: string },
  snapshot: AccountsSnapshot | null,
): AccountView | undefined {
  const providerId = session.provider
  if (!snapshot || !providerId) return undefined
  return session.providerAccountId
    ? snapshot.accounts.find((a) => a.id === session.providerAccountId && a.providerId === providerId)
    : snapshot.accounts.find((a) => a.providerId === providerId && a.isProviderDefault && a.lifecycle !== 'archived')
}

/** What a chip for a registry account shows. */
export interface ProviderAccountChip {
  accountId: string
  /** The footer's label rule (accountDisplayName): the identity's name, else
   *  the account's label; this computer's own sign-in named for what it is. */
  name: string
  colourKey: IdentityColorKey
  /** The account's own label (an email, or a key's name) for the tooltip. */
  title: string
}

/** The chip of a session that runs under a registry account (Codex): its
 *  account's identity name and colour. Null for a session of the provider
 *  whose chips go by email (Claude Code), a terminal-only tab, or when the
 *  account list cannot name the account. */
export function providerAccountChip(
  session: { provider?: ProviderId; providerAccountId?: string; shellOnly?: boolean },
  snapshot: AccountsSnapshot | null,
  displayName: (snapshot: AccountsSnapshot | null, account: AccountView) => string,
): ProviderAccountChip | null {
  if (session.shellOnly || (session.provider ?? 'claude') === 'claude') return null
  const account = sessionProviderAccount(session, snapshot)
  if (!account) return null
  const name = displayName(snapshot, account)
  return { accountId: account.id, name, colourKey: identityColourOf(snapshot, account) ?? 'mauve', title: account.providerLabel?.trim() || name }
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
