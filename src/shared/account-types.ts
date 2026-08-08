// src/shared/account-types.ts
import type { IdentityColorKey } from './identity-colors'

export interface AccountProfile {
  /** Stable id, e.g. `profile-<random>`. Used as the on-disk dir name. */
  id: string
  /** Display name, default "Personal · <localpart>", renameable. */
  name: string
  /** oauthAccount.emailAddress read from the profile's own .claude.json. */
  accountEmail: string
  /** Identity-palette colour key for the chip/dot. */
  colourKey?: IdentityColorKey
  /** The profile cloned from the default ~/.claude at the 1->2 transition. */
  isPrimary?: boolean
  /** Whether this account may be chosen when switching a session's account.
   *  Missing/undefined => active, so accounts that predate this field stay
   *  selectable with no migration. An inactive account still appears in the
   *  accounts list and the switcher, marked inactive, but cannot be selected. */
  active?: boolean
  createdAt: number
}

export interface AccountProfilesConfig {
  profiles: AccountProfile[]
}

/** An account is selectable unless it has been explicitly deactivated.
 *  Undefined => active, so pre-existing profiles need no migration and the
 *  first update after this ships leaves every account active. */
export function isAccountActive(p: Pick<AccountProfile, 'active'>): boolean {
  return p.active !== false
}
