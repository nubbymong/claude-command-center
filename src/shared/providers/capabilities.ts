// WP1 provider core: the typed capability contract (design 7.3).
//
// Provider-specific behaviour is exposed as declared capabilities, not as
// provider-name branches scattered through features. Every provider declares
// EVERY key below (WP1.56): an optional capability a provider lacks is
// declared `unsupported`, never omitted. A capability is `supported` only when
// the package also exposes the operation that backs it (enforced at
// registration); until an operation is wired the honest state is `unknown`.
// `experimental` and `unknown` are off unless the caller names the
// provider-scoped key in its owner-enabled list and the UI labels it honestly
// (WP1.41).
import type { ProviderId } from '../types'

export type CapabilityState = 'supported' | 'unsupported' | 'experimental' | 'unknown'
export const CAPABILITY_PLATFORMS = ['win32', 'darwin', 'linux'] as const
export type CapabilityPlatform = (typeof CAPABILITY_PLATFORMS)[number]

export function isCapabilityPlatform(value: unknown): value is CapabilityPlatform {
  return typeof value === 'string' && (CAPABILITY_PLATFORMS as readonly string[]).includes(value)
}

export interface CapabilityDescriptor {
  state: CapabilityState
  /** Provider CLI version range within which the state was tested (semver strings). */
  minTestedVersion?: string
  maxTestedVersion?: string
  /** Per-platform override of `state` (a capability the provider has on two
   *  platforms and not the third, e.g. Claude realms on macOS under D2). */
  platformOverrides?: Partial<Record<CapabilityPlatform, CapabilityState>>
  /** Short, honest note for the user ("beta at the provider", "not on macOS").
   *  Author-controlled today; a renderer must still render it as text, never as markup. */
  note?: string
}

/** Every capability WP1 defines. The first block is behaviour WP1 implements;
 *  the second is declared now and implemented by later packages. */
export const CAPABILITY_KEYS = [
  'cli.discovery',
  'install.recipes',
  'auth.browser',
  'auth.device',
  'auth.apiKey',
  'auth.status',
  'auth.logout',
  'realm.isolated',
  'account.labelFields',
  'account.usage',
  'session.launch',
  'session.history',
  'session.cloud',
  'session.ssh',
] as const
export type CapabilityKey = (typeof CAPABILITY_KEYS)[number]

/** What must exist on the package for a key to be declared `supported` or
 *  `experimental`: an operation object (`setup`/`auth`/`realms`), a named
 *  method on the session provider, or `null` -- nothing on the package backs
 *  this key yet, so it may not be declared supported at all.
 *
 *  Round 2 found the first shape of this map vacuous for five of the fourteen
 *  keys: all four `session.*` keys pointed at `'session'`, which
 *  `ProviderPackage` makes mandatory, and `account.usage` pointed at nothing,
 *  so no declaration among them could ever fail. Naming the method per key
 *  makes the rule bite, and a `null` backing now FORBIDS `supported` rather
 *  than waving it through. */
export type CapabilityBacking =
  | { readonly operations: 'setup' | 'auth' | 'realms' }
  | { readonly sessionMethod: string }
  | null

export const CAPABILITY_OPERATION: Readonly<Record<CapabilityKey, CapabilityBacking>> = {
  'cli.discovery': { operations: 'setup' },
  'install.recipes': { operations: 'setup' },
  'auth.browser': { operations: 'auth' },
  'auth.device': { operations: 'auth' },
  'auth.apiKey': { operations: 'auth' },
  'auth.status': { operations: 'auth' },
  'auth.logout': { operations: 'auth' },
  'realm.isolated': { operations: 'realms' },
  'account.labelFields': { operations: 'auth' },
  // Per-account usage is fetched today by src/main/usage/account-usage.ts,
  // which is not on the package: nothing here backs the key yet.
  'account.usage': null,
  'session.launch': { sessionMethod: 'buildSpawnCommand' },
  'session.history': { sessionMethod: 'listHistorySessions' },
  // Cloud agents ship through cloud-agent-manager.ts, not through
  // SessionProvider: nothing here backs the key yet.
  'session.cloud': null,
  'session.ssh': { sessionMethod: 'configureRemoteSettings' },
}

/** Keys a provider must have `supported` for WP1 setup/auth to be usable at
 *  the merge candidate. Advisory before that (they may be `unknown` while the
 *  operations are being wired); the conformance suite enforces it at the
 *  candidate phase. */
export const WP1_REQUIRED_CAPABILITIES: readonly CapabilityKey[] = [
  'cli.discovery', 'auth.status', 'auth.logout', 'session.launch',
] as const

export type ProviderCapabilities = Readonly<Record<CapabilityKey, CapabilityDescriptor>>

export function isCapabilityKey(value: unknown): value is CapabilityKey {
  return typeof value === 'string' && (CAPABILITY_KEYS as readonly string[]).includes(value)
}

export function isCapabilityState(value: unknown): value is CapabilityState {
  return value === 'supported' || value === 'unsupported' || value === 'experimental' || value === 'unknown'
}

/** An owner-enabled experimental capability is named per provider, so
 *  enabling Codex device sign-in never pre-enables it for another provider. */
export type ScopedCapabilityKey = `${ProviderId}:${CapabilityKey}`

export interface CapabilityResolution {
  key: CapabilityKey
  /** The declared state after the platform override. */
  state: CapabilityState
  /** Whether a feature may act on it right now. */
  enabled: boolean
  /** Why it is disabled, when it is. */
  reason?: 'unsupported' | 'unknown' | 'experimental-not-enabled' | 'not-declared' | 'unknown-platform'
  /** True when the caller must label the surface as experimental. */
  labelExperimental: boolean
  note?: string
}

/** Pure resolution rule shared by main and renderer. Fails closed: an
 *  unknown provider, key, platform or declaration resolves disabled. */
export function resolveCapability(
  caps: Partial<ProviderCapabilities> | undefined,
  key: CapabilityKey,
  opts: { providerId: ProviderId; platform: CapabilityPlatform; experimentalEnabled?: readonly ScopedCapabilityKey[] },
): CapabilityResolution {
  const d = caps && Object.hasOwn(caps, key) ? caps[key] : undefined
  if (!d || !isCapabilityState(d.state)) return { key, state: 'unknown', enabled: false, reason: 'not-declared', labelExperimental: false }
  if (!isCapabilityPlatform(opts.platform)) return { key, state: 'unknown', enabled: false, reason: 'unknown-platform', labelExperimental: false, note: d.note }
  const overrides = d.platformOverrides ?? {}
  const state = Object.hasOwn(overrides, opts.platform) && isCapabilityState(overrides[opts.platform]) ? overrides[opts.platform]! : d.state
  if (state === 'supported') return { key, state, enabled: true, labelExperimental: false, note: d.note }
  if (state === 'experimental') {
    const on = (opts.experimentalEnabled ?? []).includes(`${opts.providerId}:${key}`)
    return { key, state, enabled: on, reason: on ? undefined : 'experimental-not-enabled', labelExperimental: true, note: d.note }
  }
  return { key, state, enabled: false, reason: state === 'unknown' ? 'unknown' : 'unsupported', labelExperimental: false, note: d.note }
}

/** Keys whose declaration is missing or invalid (bad state, bad platform
 *  override value or platform, non-string note/version). */
export function missingCapabilityKeys(caps: Partial<Record<string, CapabilityDescriptor>> | undefined): CapabilityKey[] {
  return CAPABILITY_KEYS.filter((k) => {
    const d = caps && Object.hasOwn(caps, k) ? caps[k] : undefined
    if (!d || !isCapabilityState(d.state)) return true
    for (const [platform, state] of Object.entries(d.platformOverrides ?? {})) if (!isCapabilityPlatform(platform) || !isCapabilityState(state)) return true
    for (const v of [d.minTestedVersion, d.maxTestedVersion, d.note]) if (v !== undefined && typeof v !== 'string') return true
    return false
  })
}
