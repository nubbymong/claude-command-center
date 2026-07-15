import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  AuthProfileStore,
  pickRendererProfilePatch,
} from '../../../src/main/github/auth/auth-profile-store'
import { emptyGitHubConfig } from '../../../src/shared/github-constants'
import type { GitHubAuthFeatureKey, GitHubConfig } from '../../../src/shared/github-types'

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
  let mem: { config: GitHubConfig | null; writes: number }
  let store: AuthProfileStore

  beforeEach(() => {
    mem = { config: null, writes: 0 }
    mockSafeStorage.isEncryptionAvailable.mockReturnValue(true)
    store = new AuthProfileStore({
      readConfig: async () => mem.config,
      writeConfig: async (c) => {
        mem.config = c
        mem.writes++
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

  it('seeds featureToggles from config.featureDefaults on a new profile', async () => {
    // First-launch config (emptyGitHubConfig) carries featureDefaults =
    // DEFAULT_AUTH_FEATURE_TOGGLES, so a newly added account inherits the
    // master intent (spec 2026-06-13 s2). notifications/aiCredits default off.
    const id = await store.addProfile({
      kind: 'oauth',
      label: 'seed',
      username: 'seed',
      scopes: [],
      capabilities: [],
      rawToken: 'gho_seed',
      expiryObservable: false,
    })
    const p = mem.config!.authProfiles[id]
    expect(p.featureToggles).toEqual({
      activePR: true,
      ci: true,
      reviews: true,
      linkedIssues: true,
      notifications: false,
      aiCredits: false,
    })
    // Cloned, not shared by reference with the config-level defaults.
    expect(p.featureToggles).not.toBe(mem.config!.featureDefaults)
  })

  it('seeds featureToggles from a user-customized featureDefaults', async () => {
    // Pre-existing config whose master intent differs from the constant —
    // the new account must inherit the user's choices, not the hardcoded
    // defaults.
    mem.config = emptyGitHubConfig()
    mem.config.featureDefaults = {
      activePR: false,
      ci: true,
      reviews: false,
      linkedIssues: true,
      notifications: true,
      aiCredits: true,
    }
    const id = await store.addProfile({
      kind: 'oauth',
      label: 'custom',
      username: 'custom',
      scopes: [],
      capabilities: [],
      rawToken: 'gho_custom',
      expiryObservable: false,
    })
    expect(mem.config!.authProfiles[id].featureToggles).toEqual({
      activePR: false,
      ci: true,
      reviews: false,
      linkedIssues: true,
      notifications: true,
      aiCredits: true,
    })
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

  describe('replaceSameAccountOAuth — re-auth dedupe preserves per-account toggles', () => {
    const customToggles: Record<GitHubAuthFeatureKey, boolean> = {
      activePR: true,
      ci: false, // <-- the user's per-account intent that must survive re-auth
      reviews: true,
      linkedIssues: true,
      notifications: false,
      aiCredits: true,
    }

    it('carries the OLD profile featureToggles onto the fresh one, then removes the old', async () => {
      // Old profile: the user previously turned ci OFF and aiCredits ON for this
      // account. The fresh re-auth profile is seeded from featureDefaults (the
      // GLOBAL intent), which would silently revert those choices.
      const oldId = await store.addProfile({
        kind: 'oauth',
        label: 'octocat',
        username: 'octocat',
        scopes: ['repo'],
        capabilities: ['pulls'],
        rawToken: 'gho_old_narrow',
        expiryObservable: false,
      })
      await store.updateProfile(oldId, { featureToggles: customToggles })

      // Fresh re-auth profile for the SAME account (broader scope/token).
      const newId = await store.addProfile({
        kind: 'oauth',
        label: 'octocat',
        username: 'octocat',
        scopes: ['repo', 'user'],
        capabilities: ['pulls', 'plan'],
        rawToken: 'gho_new_broad',
        expiryObservable: false,
      })

      await store.replaceSameAccountOAuth(newId, 'octocat')

      // Old gone, new survives, and the survivor carries the user's intent.
      expect(mem.config!.authProfiles[oldId]).toBeUndefined()
      const survivor = mem.config!.authProfiles[newId]
      expect(survivor).toBeDefined()
      expect(survivor.featureToggles).toEqual(customToggles)
      expect(survivor.featureToggles).not.toBe(customToggles) // cloned, not shared
      // The fresh broad scopes/capabilities are NOT clobbered by the carry.
      expect(survivor.scopes).toEqual(['repo', 'user'])
      expect(survivor.capabilities).toEqual(['pulls', 'plan'])
    })

    it('clears defaultAuthProfileId when it pointed at the removed old profile', async () => {
      const oldId = await store.addProfile({
        kind: 'oauth', label: 'a', username: 'a', scopes: [], capabilities: [],
        rawToken: 'gho_old', expiryObservable: false,
      })
      mem.config!.defaultAuthProfileId = oldId
      const newId = await store.addProfile({
        kind: 'oauth', label: 'a', username: 'a', scopes: [], capabilities: [],
        rawToken: 'gho_new', expiryObservable: false,
      })
      await store.replaceSameAccountOAuth(newId, 'a')
      expect(mem.config!.defaultAuthProfileId).toBeUndefined()
      expect(mem.config!.authProfiles[oldId]).toBeUndefined()
      expect(mem.config!.authProfiles[newId]).toBeDefined()
    })

    it('leaves a DIFFERENT account untouched', async () => {
      const other = await store.addProfile({
        kind: 'oauth', label: 'other', username: 'other', scopes: [], capabilities: [],
        rawToken: 'gho_other', expiryObservable: false,
      })
      const newId = await store.addProfile({
        kind: 'oauth', label: 'me', username: 'me', scopes: [], capabilities: [],
        rawToken: 'gho_me', expiryObservable: false,
      })
      await store.replaceSameAccountOAuth(newId, 'me')
      expect(mem.config!.authProfiles[other]).toBeDefined()
      expect(mem.config!.authProfiles[newId]).toBeDefined()
    })

    it('first-ever auth (no old profile to replace) is a no-op write', async () => {
      const newId = await store.addProfile({
        kind: 'oauth', label: 'solo', username: 'solo', scopes: [], capabilities: [],
        rawToken: 'gho_solo', expiryObservable: false,
      })
      const writesBefore = mem.writes
      await store.replaceSameAccountOAuth(newId, 'solo')
      expect(mem.writes).toBe(writesBefore) // nothing replaced, nothing written
      expect(mem.config!.authProfiles[newId]).toBeDefined()
    })
  })

  describe('pickRendererProfilePatch — IPC boundary narrowing', () => {
    it('keeps ONLY label + featureToggles, dropping auth-system + immutable fields', () => {
      const featureToggles: Record<GitHubAuthFeatureKey, boolean> = {
        activePR: true, ci: false, reviews: true, linkedIssues: true,
        notifications: false, aiCredits: false,
      }
      const out = pickRendererProfilePatch({
        label: 'x',
        featureToggles,
        // Everything below is an auth-system / immutable field the renderer must
        // NOT be able to assert — they are cast in to simulate a hostile/buggy
        // renderer bypassing the compile-time type at the IPC boundary.
        ...({
          capabilities: ['plan'],
          scopes: ['repo'],
          tokenCiphertext: 'evil',
          expiresAt: 0,
          lastVerifiedAt: 0,
          id: 'hijack',
        } as object),
      })
      expect(out).toEqual({ label: 'x', featureToggles })
      expect(Object.keys(out).sort()).toEqual(['featureToggles', 'label'])
    })

    it('drops undefined keys (never overwrites an existing value with undefined)', () => {
      expect(pickRendererProfilePatch({})).toEqual({})
      expect(pickRendererProfilePatch({ label: 'only' })).toEqual({ label: 'only' })
    })
  })
})
