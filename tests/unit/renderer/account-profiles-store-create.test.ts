// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AccountProfile } from '../../../src/shared/account-types'
import { useAccountProfilesStore } from '../../../src/renderer/stores/accountProfilesStore'

describe('accountProfilesStore.create', () => {
  beforeEach(() => { useAccountProfilesStore.setState({ profiles: [] }) })

  it('invokes IPC create, re-hydrates, returns the profile', async () => {
    const profile: AccountProfile = { id: 'profile-x', name: 'Work', accountEmail: '', createdAt: 1 }
    ;(globalThis as any).window.electronAPI = {
      accountProfiles: {
        create: vi.fn().mockResolvedValue(profile),
        list: vi.fn().mockResolvedValue([profile]),
      },
    }
    const created = await useAccountProfilesStore.getState().create('Work')
    expect(created).toEqual(profile)
    expect(useAccountProfilesStore.getState().profiles).toContainEqual(profile)
  })
})
