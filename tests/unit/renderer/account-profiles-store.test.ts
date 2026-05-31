// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AccountProfile } from '../../../src/shared/account-types'
import { useAccountProfilesStore } from '../../../src/renderer/stores/accountProfilesStore'

const profile: AccountProfile = {
  id: 'p1',
  name: 'Personal · nicholas',
  accountEmail: 'nicholas@example.com',
  colourKey: 'mauve',
  isPrimary: true,
  createdAt: 0,
}

const listMock = vi.fn<[], Promise<AccountProfile[]>>(async () => [profile])

beforeEach(() => {
  listMock.mockClear()
  listMock.mockResolvedValue([profile])
  ;(globalThis as any).window.electronAPI = {
    accountProfiles: { list: listMock },
  }
  // Reset store to a clean slate between tests.
  useAccountProfilesStore.setState({ profiles: [] })
})

describe('accountProfilesStore', () => {
  it('hydrate() populates profiles from accountProfiles.list()', async () => {
    expect(useAccountProfilesStore.getState().profiles).toEqual([])
    await useAccountProfilesStore.getState().hydrate()
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(useAccountProfilesStore.getState().profiles).toEqual([profile])
  })

  it('profileName() returns the matching profile name', async () => {
    await useAccountProfilesStore.getState().hydrate()
    expect(useAccountProfilesStore.getState().profileName('p1')).toBe('Personal · nicholas')
  })

  it('profileName() returns undefined for an unknown id or undefined id', async () => {
    await useAccountProfilesStore.getState().hydrate()
    expect(useAccountProfilesStore.getState().profileName('nope')).toBeUndefined()
    expect(useAccountProfilesStore.getState().profileName(undefined)).toBeUndefined()
  })

  it('hydrate() swallows a rejected list() and leaves profiles unchanged', async () => {
    listMock.mockRejectedValueOnce(new Error('boom'))
    await useAccountProfilesStore.getState().hydrate()
    expect(useAccountProfilesStore.getState().profiles).toEqual([])
  })
})
