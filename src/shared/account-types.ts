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
  createdAt: number
}

export interface AccountProfilesConfig {
  profiles: AccountProfile[]
}
