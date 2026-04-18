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

  it('refuses empty/whitespace rawToken for non-gh-cli kinds', async () => {
    await expect(
      store.addProfile({
        // @ts-expect-error — runtime guard must still catch callers bypassing the discriminated union
        kind: 'pat-classic',
        label: 'x',
        username: 'x',
        scopes: [],
        capabilities: [],
        rawToken: '',
        expiryObservable: false,
      }),
    ).rejects.toThrow(/non-empty/i)
    await expect(
      store.addProfile({
        // @ts-expect-error
        kind: 'oauth',
        label: 'x',
        username: 'x',
        scopes: [],
        capabilities: [],
        rawToken: '   ',
        expiryObservable: false,
      }),
    ).rejects.toThrow(/non-empty/i)
    expect(mem.config).toBeNull()
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

  it('updateProfile cannot patch tokenCiphertext, id, kind, createdAt, or ghCliUsername', async () => {
    const id = await store.addProfile({
      kind: 'gh-cli',
      label: 'original',
      username: 'x',
      scopes: [],
      capabilities: [],
      ghCliUsername: 'nubbymong',
      expiryObservable: false,
    })
    const originalCreatedAt = mem.config!.authProfiles[id].createdAt
    await store.updateProfile(id, {
      // @ts-expect-error — whitelist blocks these fields at compile time; runtime guard backs it up
      tokenCiphertext: 'attacker_plaintext',
      // @ts-expect-error
      id: 'hijack',
      // @ts-expect-error
      kind: 'pat-classic',
      // @ts-expect-error
      createdAt: 0,
      // @ts-expect-error — ghCliUsername must stay immutable; patching it would hijack the gh account binding
      ghCliUsername: 'attacker',
      label: 'renamed',
    })
    const p = mem.config!.authProfiles[id]
    expect(p.tokenCiphertext).toBeUndefined()
    expect(p.id).toBe(id)
    expect(p.kind).toBe('gh-cli')
    expect(p.createdAt).toBe(originalCreatedAt)
    expect(p.ghCliUsername).toBe('nubbymong')
    expect(p.label).toBe('renamed')
  })

  it('getToken returns null (does not throw) when decryption fails', async () => {
    const id = await store.addProfile({
      kind: 'pat-classic',
      label: 'x',
      username: 'x',
      scopes: [],
      capabilities: [],
      rawToken: 'ghp_ok',
      expiryObservable: false,
    })
    const originalDecrypt = mockSafeStorage.decryptString
    ;(mockSafeStorage as unknown as { decryptString: () => string }).decryptString = () => {
      throw new Error('decrypt failed — corrupt ciphertext or wrong machine')
    }
    try {
      await expect(store.getToken(id)).resolves.toBeNull()
    } finally {
      ;(mockSafeStorage as unknown as { decryptString: typeof originalDecrypt }).decryptString = originalDecrypt
    }
  })

  it('getToken returns null when safeStorage.isEncryptionAvailable() becomes false', async () => {
    const id = await store.addProfile({
      kind: 'pat-classic',
      label: 'x',
      username: 'x',
      scopes: [],
      capabilities: [],
      rawToken: 'ghp_ok',
      expiryObservable: false,
    })
    // Keychain flipped unavailable after profile creation (e.g., user logged out).
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(false)
    await expect(store.getToken(id)).resolves.toBeNull()
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
