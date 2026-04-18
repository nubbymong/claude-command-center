import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import type { AuthProfile, GitHubConfig } from '../../../shared/github-types'
import {
  GITHUB_CONFIG_SCHEMA_VERSION,
  DEFAULT_SYNC_INTERVALS,
  DEFAULT_FEATURE_TOGGLES,
} from '../../../shared/github-constants'
import { AsyncMutex } from '../async-mutex'

export interface AuthProfileStoreIO {
  readConfig(): Promise<GitHubConfig | null>
  writeConfig(config: GitHubConfig): Promise<void>
}

export interface AddProfileInput {
  kind: AuthProfile['kind']
  label: string
  username: string
  avatarUrl?: string
  scopes: string[]
  capabilities: AuthProfile['capabilities']
  allowedRepos?: string[]
  rawToken?: string
  ghCliUsername?: string
  expiresAt?: number
  expiryObservable: boolean
}

// Whitelist of fields callers may patch via updateProfile.
// `tokenCiphertext` is DELIBERATELY excluded — token rotation must go through
// `rotateToken()` so every token write hits safeStorage.
export type ProfilePatch = Partial<
  Pick<
    AuthProfile,
    | 'label'
    | 'username'
    | 'avatarUrl'
    | 'scopes'
    | 'capabilities'
    | 'allowedRepos'
    | 'lastVerifiedAt'
    | 'lastAuthErrorAt'
    | 'expiresAt'
    | 'expiryObservable'
    | 'rateLimits'
  >
>

function emptyConfig(): GitHubConfig {
  return {
    schemaVersion: GITHUB_CONFIG_SCHEMA_VERSION,
    authProfiles: {},
    featureToggles: { ...DEFAULT_FEATURE_TOGGLES },
    syncIntervals: { ...DEFAULT_SYNC_INTERVALS },
    enabledByDefault: false,
    transcriptScanningOptIn: false,
  }
}

export class AuthProfileStore {
  private mutex = new AsyncMutex()

  constructor(private io: AuthProfileStoreIO) {}

  private async load(): Promise<GitHubConfig> {
    return (await this.io.readConfig()) ?? emptyConfig()
  }

  async addProfile(input: AddProfileInput): Promise<string> {
    return this.mutex.run(async () => {
      const id = randomUUID()
      const config = await this.load()

      let tokenCiphertext: string | undefined
      if (input.rawToken && input.kind !== 'gh-cli') {
        if (!safeStorage.isEncryptionAvailable()) {
          // Do NOT write anything — abort so the config file stays clean.
          throw new Error('OS keychain unavailable; cannot encrypt token')
        }
        tokenCiphertext = safeStorage.encryptString(input.rawToken).toString('base64')
      }

      config.authProfiles[id] = {
        id,
        kind: input.kind,
        label: input.label,
        username: input.username,
        avatarUrl: input.avatarUrl,
        scopes: input.scopes,
        capabilities: input.capabilities,
        allowedRepos: input.allowedRepos,
        tokenCiphertext,
        ghCliUsername: input.ghCliUsername,
        createdAt: Date.now(),
        lastVerifiedAt: Date.now(),
        expiresAt: input.expiresAt,
        expiryObservable: input.expiryObservable,
      }
      await this.io.writeConfig(config)
      return id
    })
  }

  async getToken(id: string): Promise<string | null> {
    const config = await this.load()
    const p = config.authProfiles[id]
    if (!p || !p.tokenCiphertext) return null
    const buf = Buffer.from(p.tokenCiphertext, 'base64')
    return safeStorage.decryptString(buf)
  }

  async removeProfile(id: string): Promise<void> {
    await this.mutex.run(async () => {
      const config = await this.load()
      delete config.authProfiles[id]
      if (config.defaultAuthProfileId === id) config.defaultAuthProfileId = undefined
      await this.io.writeConfig(config)
    })
  }

  async updateProfile(id: string, patch: ProfilePatch): Promise<void> {
    await this.mutex.run(async () => {
      const config = await this.load()
      const existing = config.authProfiles[id]
      if (!existing) throw new Error(`Profile not found: ${id}`)
      // Strip id / kind / tokenCiphertext defensively in case caller bypassed types.
      const { id: _i, kind: _k, tokenCiphertext: _t, createdAt: _c, ...safePatch } =
        patch as Partial<AuthProfile>
      config.authProfiles[id] = { ...existing, ...safePatch }
      await this.io.writeConfig(config)
    })
  }

  async rotateToken(id: string, rawToken: string): Promise<void> {
    await this.mutex.run(async () => {
      const config = await this.load()
      const existing = config.authProfiles[id]
      if (!existing) throw new Error(`Profile not found: ${id}`)
      if (existing.kind === 'gh-cli') {
        throw new Error('Cannot rotate token on gh-cli profile')
      }
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('OS keychain unavailable; cannot encrypt token')
      }
      const tokenCiphertext = safeStorage.encryptString(rawToken).toString('base64')
      config.authProfiles[id] = { ...existing, tokenCiphertext, lastVerifiedAt: Date.now() }
      await this.io.writeConfig(config)
    })
  }

  async listProfiles(): Promise<AuthProfile[]> {
    const config = await this.load()
    return Object.values(config.authProfiles)
  }
}
