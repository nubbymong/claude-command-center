import { create } from 'zustand'
import type { AccountProfile } from '../../shared/account-types'

interface AccountProfilesState {
  /** All known account profiles, hydrated from the main process on boot. */
  profiles: AccountProfile[]
  /** Pull the profile list from main and replace local state. Idempotent;
   *  swallows IPC failures so a boot-time hydrate never crashes the app. */
  hydrate: () => Promise<void>
  /** Resolve a profileId to its display name (used by the status strip /
   *  session row chips). Returns undefined for a missing/unknown id so callers
   *  can fall back to the alias map / raw email via resolveAccountName. */
  profileName: (profileId?: string) => string | undefined
  /** Create a new empty account profile via IPC, re-hydrate, and return it. */
  create: (name?: string) => Promise<AccountProfile>
}

export const useAccountProfilesStore = create<AccountProfilesState>((set, get) => ({
  profiles: [],

  hydrate: async () => {
    try {
      const profiles = await window.electronAPI.accountProfiles.list()
      set({ profiles })
    } catch (err) {
      console.error('[accountProfilesStore] hydrate failed:', err)
    }
  },

  profileName: (profileId) => {
    if (!profileId) return undefined
    return get().profiles.find((p) => p.id === profileId)?.name
  },

  create: async (name) => {
    const profile = await window.electronAPI.accountProfiles.create(name)
    await get().hydrate()
    return profile
  },
}))
