import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AuthProfileStore } from '../../../src/main/github/auth/auth-profile-store'
import type { GitHubConfig } from '../../../src/shared/github-types'

const { mockSafeStorage } = vi.hoisted(() => ({
  mockSafeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, ''),
  },
}))

vi.mock('electron', () => ({
  safeStorage: mockSafeStorage,
}))

describe('AuthProfileStore', () => {
  let mem: { config: GitHubConfig | null }
  let store: AuthProfileStore

  beforeEach(() => {
    mem = { config: null }
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true)
    store = new AuthProfileStore({
      readConfig: async () => mem.config,
      writeConfig: async (c) => {
        mem.config = c
      },
    })
  })

  it('adds PAT profile with encrypted token', async () => {
    const id = await store.addProfile({
      kind: 'pat-fine-grained',
      label: 'n',
      username: 'n',
      scopes: ['pull_requests'],
      capabilities: ['pulls'],
      rawToken: 'github_pat_ABC',
      expiryObservable: true,
    })
    const p = mem.config!.authProfiles[id]
    expect(p.tokenCiphertext).toBeTruthy()
    expect(p.tokenCiphertext).not.toBe('github_pat_ABC')
  })

  it('decrypts on getToken', async () => {
    const id = await store.addProfile({
      kind: 'pat-classic',
      label: 'x',
      username: 'x',
      scopes: [],
      capabilities: [],
      rawToken: 'ghp_X',
      expiryObservable: false,
    })
    expect(await store.getToken(id)).toBe('ghp_X')
  })

  it('gh-cli kind stores no ciphertext', async () => {
    const id = await store.addProfile({
      kind: 'gh-cli',
      label: 'cli',
      username: 'foo',
      scopes: [],
      capabilities: [],
      ghCliUsername: 'foo',
      expiryObservable: false,
    })
    expect(mem.config!.authProfiles[id].tokenCiphertext).toBeUndefined()
    expect(mem.config!.authProfiles[id].ghCliUsername).toBe('foo')
  })

  it('removeProfile wipes entry and clears defaultAuthProfileId if it was default', async () => {
    const id = await store.addProfile({
      kind: 'oauth',
      label: 'x',
      username: 'x',
      scopes: [],
      capabilities: [],
      rawToken: 'gho_x',
      expiryObservable: false,
    })
    mem.config!.defaultAuthProfileId = id
    await store.removeProfile(id)
    expect(mem.config!.authProfiles[id]).toBeUndefined()
    expect(mem.config!.defaultAuthProfileId).toBeUndefined()
  })

  it('updateProfile throws on unknown id', async () => {
    await expect(store.updateProfile('nope', { label: 'x' })).rejects.toThrow(/not found/)
  })

  it('listProfiles returns array', async () => {
    await store.addProfile({
      kind: 'oauth',
      label: 'x',
      username: 'x',
      scopes: [],
      capabilities: [],
      rawToken: 'gho_',
      expiryObservable: false,
    })
    expect((await store.listProfiles()).length).toBe(1)
  })

  it('refuses to write when safeStorage is unavailable — config stays untouched', async () => {
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false)
    await expect(
      store.addProfile({
        kind: 'pat-classic',
        label: 'x',
        username: 'x',
        scopes: [],
        capabilities: [],
        rawToken: 'ghp_X',
        expiryObservable: false,
      }),
    ).rejects.toThrow(/keychain/i)
    expect(mem.config).toBeNull()
  })

  it('updateProfile cannot patch tokenCiphertext, id, kind, or createdAt', async () => {
    const id = await store.addProfile({
      kind: 'pat-classic',
      label: 'original',
      username: 'x',
      scopes: [],
      capabilities: [],
      rawToken: 'ghp_original',
      expiryObservable: false,
    })
    const originalCiphertext = mem.config!.authProfiles[id].tokenCiphertext
    const originalCreatedAt = mem.config!.authProfiles[id].createdAt
    await store.updateProfile(id, {
      // @ts-expect-error — whitelist blocks these fields at compile time; runtime guard backs it up
      tokenCiphertext: 'attacker_plaintext',
      // @ts-expect-error
      id: 'hijack',
      // @ts-expect-error
      kind: 'gh-cli',
      // @ts-expect-error
      createdAt: 0,
      label: 'renamed',
    })
    const p = mem.config!.authProfiles[id]
    expect(p.tokenCiphertext).toBe(originalCiphertext)
    expect(p.id).toBe(id)
    expect(p.kind).toBe('pat-classic')
    expect(p.createdAt).toBe(originalCreatedAt)
    expect(p.label).toBe('renamed')
  })

  it('rotateToken re-encrypts through safeStorage', async () => {
    const id = await store.addProfile({
      kind: 'pat-classic',
      label: 'x',
      username: 'x',
      scopes: [],
      capabilities: [],
      rawToken: 'ghp_old',
      expiryObservable: false,
    })
    await store.rotateToken(id, 'ghp_new')
    expect(await store.getToken(id)).toBe('ghp_new')
  })

  it('rotateToken refuses gh-cli profiles', async () => {
    const id = await store.addProfile({
      kind: 'gh-cli',
      label: 'cli',
      username: 'foo',
      scopes: [],
      capabilities: [],
      ghCliUsername: 'foo',
      expiryObservable: false,
    })
    await expect(store.rotateToken(id, 'ghp_X')).rejects.toThrow(/gh-cli/)
  })

  it('serializes concurrent addProfile calls — no lost updates', async () => {
    const adds = Array.from({ length: 10 }, (_, i) =>
      store.addProfile({
        kind: 'pat-classic',
        label: `p${i}`,
        username: `u${i}`,
        scopes: [],
        capabilities: [],
        rawToken: `ghp_${i}`,
        expiryObservable: false,
      }),
    )
    await Promise.all(adds)
    expect(Object.keys(mem.config!.authProfiles).length).toBe(10)
  })
})
