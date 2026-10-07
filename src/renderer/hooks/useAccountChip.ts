// src/renderer/hooks/useAccountChip.ts
//
// P3.6 (quality round 1): what the session strip and every sidebar card read
// from the account list, and nothing more. Each hook selects only the chip's
// own values (strings, never the list itself), so a change elsewhere in the
// list -- another account's state, a sign-in elsewhere, a new list object
// with the same content -- re-renders no strip and no card. The rules are
// utils/accountChip's and utils/switchAccountItems'.
import { useMemo } from 'react'
import { useProviderAccountsStore, accountDisplayName } from '../stores/providerAccountsStore'
import { providerAccountChip, chipColourKeyForEmail } from '../utils/accountChip'
import type { ChipSources, ProviderAccountChip } from '../utils/accountChip'
import { switchAccountItems } from '../utils/switchAccountItems'
import type { SwitchAccountItem } from '../utils/switchAccountItems'
import type { IdentityColorKey } from '../../shared/identity-colors'

type ChipSession = Parameters<typeof providerAccountChip>[0]

/** The chip of a session that runs under a registry account, or null (see
 *  providerAccountChip). */
export function useProviderAccountChip(session: ChipSession | null | undefined): ProviderAccountChip | null {
  const read = (s: { snapshot: Parameters<typeof providerAccountChip>[1] }) => (session ? providerAccountChip(session, s.snapshot, accountDisplayName) : null)
  const accountId = useProviderAccountsStore((s) => read(s)?.accountId ?? null)
  const name = useProviderAccountsStore((s) => read(s)?.name ?? null)
  const colourKey = useProviderAccountsStore((s) => read(s)?.colourKey ?? null)
  const title = useProviderAccountsStore((s) => read(s)?.title ?? null)
  return useMemo(
    () => (accountId !== null && name !== null && colourKey !== null && title !== null ? { accountId, name, colourKey, title } : null),
    [accountId, name, colourKey, title],
  )
}

/** The colour key of a chip that names a Claude account by its email (see
 *  chipColourKeyForEmail). */
export function useEmailChipColourKey(email: string | undefined, sources: Omit<ChipSources, 'snapshot'>, fallback: IdentityColorKey | undefined): IdentityColorKey {
  return useProviderAccountsStore((s) => chipColourKeyForEmail(email, { ...sources, snapshot: s.snapshot }, fallback))
}

/** The Switch account list for a session (see switchAccountItems), read as
 *  its own text so an unchanged list is the same list. */
export function useSwitchAccountItems(
  session: Parameters<typeof switchAccountItems>[0],
  sources: Omit<Parameters<typeof switchAccountItems>[1], 'snapshot'>,
): SwitchAccountItem[] {
  const key = useProviderAccountsStore((s) => JSON.stringify(switchAccountItems(session, { ...sources, snapshot: s.snapshot })))
  return useMemo(() => JSON.parse(key) as SwitchAccountItem[], [key])
}
