import type { AccountProfile } from '../../shared/account-types'

/**
 * Default selection for the New Session account picker.
 *
 * Order of precedence:
 *  1. An explicit, non-empty `initialProfileId` (editing an existing config, or
 *     re-opening a dialog seeded with a chosen account) is honoured verbatim.
 *  2. Otherwise the primary profile's id (the one cloned from the default
 *     ~/.claude at the 1->2 transition) is pre-selected.
 *  3. Otherwise '' -- defensive fallback; effectively unreachable in the
 *     multi-account UI (this path only exists when no profiles are present,
 *     which is the condition that hides the account picker entirely).
 *
 * An empty-string `initialProfileId` is treated as "no selection" so it falls
 * through to the primary/default rule.
 */
export function defaultPickerProfileId(
  profiles: AccountProfile[],
  initialProfileId: string | undefined,
): string {
  if (initialProfileId) return initialProfileId
  return profiles.find((p) => p.isPrimary)?.id ?? ''
}
