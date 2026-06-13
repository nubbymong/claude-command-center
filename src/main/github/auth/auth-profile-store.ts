import { safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import type { AuthProfile, GitHubConfig, RendererProfilePatch } from '../../../shared/github-types'
import { DEFAULT_AUTH_FEATURE_TOGGLES, emptyGitHubConfig } from '../../../shared/github-constants'
import { AsyncMutex } from '../async-mutex'

export interface AuthProfileStoreIO {
  readConfig(): Promise<GitHubConfig | null>
  writeConfig(config: GitHubConfig): Promise<void>
}

/**
 * Discriminated union keyed by `kind`. Forces callers to supply the right
 * credential material for each auth flavor at compile time:
 *   - gh-cli: ghCliUsername required, rawToken forbidden (tokens fetched
 *     on-demand from gh — never stored)
 *   - oauth / pat-classic / pat-fine-grained: rawToken required,
 *     ghCliUsername forbidden
 */
interface AddProfileInputCommon {
  label: string
  username: string
  avatarUrl?: string
  scopes: string[]
  capabilities: AuthProfile['capabilities']
  allowedRepos?: string[]
  expiresAt?: number
  expiryObservable: boolean
}
export type AddProfileInput =
  | (AddProfileInputCommon & {
      kind: 'gh-cli'
      ghCliUsername: string
      rawToken?: never
    })
  | (AddProfileInputCommon & {
      kind: 'oauth' | 'pat-classic' | 'pat-fine-grained'
      rawToken: string
      ghCliUsername?: never
    })

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
    // Per-account feature enablement. The map is replaced WHOLE, not
    // deep-merged — callers send the full toggle set they want persisted
    // (see githubStore feature actions, which read-modify-write via
    // effectiveToggle so partial maps inherit defaults at write time).
    | 'featureToggles'
  >
>

/**
 * Narrows a raw renderer-supplied patch down to the ONLY fields the renderer
 * is permitted to assert (label, featureToggles). Auth-system fields — scopes,
 * capabilities, expiry, verification timestamps, tokenCiphertext — are derived
 * from token verification in the main process; a renderer must never be able to
 * forge them via GITHUB_PROFILE_UPDATE. Undefined keys are dropped so the patch
 * never overwrites an existing value with `undefined`.
 */
export function pickRendererProfilePatch(patch: RendererProfilePatch): RendererProfilePatch {
  const out: RendererProfilePatch = {}
  if (patch.label !== undefined) out.label = patch.label
  if (patch.featureToggles !== undefined) out.featureToggles = patch.featureToggles
  return out
}

export class AuthProfileStore {
  private mutex = new AsyncMutex()

  constructor(private io: AuthProfileStoreIO) {}

  private async load(): Promise<GitHubConfig> {
    return (await this.io.readConfig()) ?? emptyGitHubConfig()
  }

  async addProfile(input: AddProfileInput): Promise<string> {
    return this.mutex.run(async () => {
      const id = randomUUID()
      const config = await this.load()

      let tokenCiphertext: string | undefined
      if (input.kind !== 'gh-cli') {
        // Non-gh-cli kinds are typed as requiring rawToken (discriminated
        // union), but the runtime must still reject empty/whitespace tokens
        // — a caller bypassing the type at the IPC boundary could otherwise
        // create a profile with no usable credential and get silent auth
        // failures downstream.
        if (typeof input.rawToken !== 'string' || input.rawToken.trim().length === 0) {
          throw new Error(`${input.kind} profile requires a non-empty rawToken`)
        }
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
        // spec 2026-06-13 s2: featureDefaults seeds every newly added account
        // so a fresh profile inherits the user's master intent. Cloned (spread)
        // so the new profile doesn't share the config's defaults object by
        // reference. config carries featureDefaults post-migration; fall back
        // to the constant for pre-migration / first-launch configs.
        featureToggles: { ...(config.featureDefaults ?? DEFAULT_AUTH_FEATURE_TOGGLES) },
      }
      await this.io.writeConfig(config)
      return id
    })
  }

  async getToken(id: string): Promise<string | null> {
    const config = await this.load()
    const p = config.authProfiles[id]
    if (!p || !p.tokenCiphertext) return null
    // Decryption can throw if:
    //   - OS keychain is unavailable (logged out, locked, deleted entry)
    //   - ciphertext was produced on a different machine/user (config copied)
    //   - the base64 blob is corrupt
    // Any of those should return null (callers flag for re-auth), not crash.
    if (!safeStorage.isEncryptionAvailable()) return null
    try {
      const buf = Buffer.from(p.tokenCiphertext, 'base64')
      return safeStorage.decryptString(buf)
    } catch {
      return null
    }
  }

  async removeProfile(id: string): Promise<void> {
    await this.mutex.run(async () => {
      const config = await this.load()
      delete config.authProfiles[id]
      if (config.defaultAuthProfileId === id) config.defaultAuthProfileId = undefined
      await this.io.writeConfig(config)
    })
  }

  /**
   * Re-auth dedupe for the SAME GitHub account: after a fresh oauth profile
   * (`newId`) is added, this carries the user's per-account featureToggles from
   * the OLD same-username profile(s) onto the new one and removes the olds — all
   * in ONE transaction so the new profile is never observed with the wrong
   * toggles and a concurrent reader can't see a half-applied state.
   *
   * The new profile was just seeded from featureDefaults (addProfile), which is
   * the GLOBAL intent, not this account's. The old profile's map IS the user's
   * intent for this account, so it always wins when present. Without this, a
   * re-auth silently reverts per-account toggles to the master defaults.
   */
  async replaceSameAccountOAuth(newId: string, username: string): Promise<void> {
    await this.mutex.run(async () => {
      const config = await this.load()
      const fresh = config.authProfiles[newId]
      if (!fresh) return
      let carried: AuthProfile['featureToggles']
      for (const [pid, p] of Object.entries(config.authProfiles)) {
        if (pid === newId || p.kind !== 'oauth' || p.username !== username) continue
        // Newest old profile wins if there were somehow several; the loop order
        // is insertion order, so the last match is the most recently added.
        if (p.featureToggles) carried = p.featureToggles
        delete config.authProfiles[pid]
        if (config.defaultAuthProfileId === pid) config.defaultAuthProfileId = undefined
      }
      if (carried) {
        config.authProfiles[newId] = { ...fresh, featureToggles: { ...carried } }
      }
      await this.io.writeConfig(config)
    })
  }

  async updateProfile(id: string, patch: ProfilePatch): Promise<void> {
    await this.mutex.run(async () => {
      const config = await this.load()
      const existing = config.authProfiles[id]
      if (!existing) throw new Error(`Profile not found: ${id}`)
      // Strip all immutable-by-design fields even if a caller bypassed the
      // ProfilePatch compile-time type. `ghCliUsername` is included because
      // it's the primary key for gh-cli profiles — patching it would silently
      // hijack the mapping to another gh account.
      const {
        id: _i,
        kind: _k,
        tokenCiphertext: _t,
        createdAt: _c,
        ghCliUsername: _g,
        ...safePatch
      } = patch as Partial<AuthProfile>
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
      // Mirror the addProfile guard — rotating to an empty/whitespace token
      // would persist a profile that always fails downstream auth.
      if (typeof rawToken !== 'string' || rawToken.trim().length === 0) {
        throw new Error('rotateToken requires a non-empty rawToken')
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
