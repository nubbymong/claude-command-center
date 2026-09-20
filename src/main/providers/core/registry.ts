// WP1 provider core (main): the provider registry.
//
// Two views over one registration: the session-provider registry the runtime
// already uses (`getProvider('claude')` from pty-manager and boot), and the
// package registry WP1 adds (capabilities, ambient/owned variables, setup/
// auth/realm operations). Only the composition root (`../compose.ts`)
// registers packages; this module imports no concrete provider.
import type { ProviderId, RealmEnvPatch } from '../../../shared/providers'
import {
  PROVIDER_IDS, isProviderId, isCapabilityPlatform, resolveCapability, missingCapabilityKeys, applyRealmEnvPatch,
  CAPABILITY_KEYS, CAPABILITY_OPERATION, isNeverOwnedLaunchVariable,
} from '../../../shared/providers'
import type { CapabilityKey, CapabilityPlatform, CapabilityResolution, ScopedCapabilityKey } from '../../../shared/providers'
import type { SessionProvider } from '../types'
import type { ProviderPackage } from './package'

const sessions = new Map<ProviderId, SessionProvider>()
const packages = new Map<ProviderId, ProviderPackage>()

/** Session-provider registration (pre-WP1 API). No production module calls it
 *  any more -- both providers register through their package, and R3 forbids a
 *  reference to it outside the registry and the composition roots -- so in
 *  practice it is the shape tests register a fake through. Kept because the
 *  refusal below is the invariant that matters: once a package owns an id, the
 *  package and its runtime surface can never be made to disagree. */
export function registerProvider(provider: SessionProvider): void {
  if (!isProviderId(provider.id)) throw new Error(`registerProvider: unknown provider id "${String(provider.id)}"`)
  if (packages.has(provider.id)) throw new Error(`registerProvider(${provider.id}): a provider package owns this id; register through the package`)
  sessions.set(provider.id, provider)
}

export function getProvider(id: ProviderId): SessionProvider {
  const p = sessions.get(id)
  if (!p) throw new Error(`SessionProvider "${id}" not registered`)
  return p
}

export function tryGetProvider(id: ProviderId): SessionProvider | null {
  return sessions.get(id) ?? null
}

/** Why a package is not registrable, or null. Exported so the conformance
 *  suite can assert the same rule the composition root relies on. Accepts
 *  `unknown` because it is the shape check: a malformed package must come
 *  back as a message, never as a TypeError from the check itself. */
export function packageRegistrationProblem(pkg: ProviderPackage): string | null {
  if (!pkg || typeof pkg !== 'object') return `package must be an object, got ${pkg === null ? 'null' : typeof pkg}`
  if (!isProviderId(pkg.id)) return `unknown provider id "${String(pkg.id)}"`
  if (!pkg.session || pkg.session.id !== pkg.id) return `session provider id "${String(pkg.session?.id)}" does not match`
  const missing = missingCapabilityKeys(pkg.capabilities)
  if (missing.length) return `capability declaration incomplete or invalid: ${missing.join(', ')}`
  for (const list of ['ambientAuthVariables', 'ownedLaunchVariables'] as const) {
    if (!Array.isArray(pkg[list]) || pkg[list].some((v) => typeof v !== 'string' || !v)) return `${list} must be declared`
    // A package may not own a variable that decides what the child process
    // executes -- owning PATH would make "no PATH hijack" a comment rather
    // than a rule, and the launch path, not the realm patch, composes PATH.
    const denied = pkg[list].find((v) => isNeverOwnedLaunchVariable(v))
    if (denied) return `${list} may not contain ${denied}: it decides what the child process executes, not which realm it uses`
  }
  for (const key of CAPABILITY_KEYS) {
    const d = pkg.capabilities[key]
    // Platform overrides are declarations too: a key that is `unknown` by
    // default and `supported` on win32 resolves enabled on win32, so it must
    // be backed exactly as an unconditional `supported` would be.
    const claimed = [d.state, ...Object.values(d.platformOverrides ?? {})].find((s) => s === 'supported' || s === 'experimental')
    if (!claimed) continue
    const backing = CAPABILITY_OPERATION[key]
    if (!backing) return `${key} is ${claimed} but nothing on the package backs it (declare it unknown until an operation exists)`
    if ('operations' in backing) {
      if (!pkg[backing.operations]) return `${key} is ${claimed} but the package exposes no ${backing.operations} operations (declare it unknown until wired)`
    } else if (typeof (pkg.session as unknown as Record<string, unknown>)[backing.sessionMethod] !== 'function') {
      return `${key} is ${claimed} but the session provider has no ${backing.sessionMethod}() (declare it unknown until wired)`
    }
  }
  return null
}

/** Package registration (WP1). Registers the package's session provider too.
 *  Fails closed on an incomplete declaration, an unbacked capability or a
 *  duplicate id. */
export function registerProviderPackage(pkg: ProviderPackage): void {
  const problem = packageRegistrationProblem(pkg)
  if (problem) throw new Error(`registerProviderPackage(${String(pkg?.id)}): ${problem}`)
  if (packages.has(pkg.id)) throw new Error(`registerProviderPackage(${pkg.id}): already registered`)
  packages.set(pkg.id, pkg)
  sessions.set(pkg.id, pkg.session)
}

export function getProviderPackage(id: ProviderId): ProviderPackage {
  const p = packages.get(id)
  if (!p) throw new Error(`ProviderPackage "${id}" not registered`)
  return p
}

export function tryGetProviderPackage(id: ProviderId): ProviderPackage | null {
  return packages.get(id) ?? null
}

export function listProviderPackages(): readonly ProviderPackage[] {
  return PROVIDER_IDS.map((id) => packages.get(id)).filter((p): p is ProviderPackage => !!p)
}

/** Resolve a capability for a registered provider on the current platform.
 *  `experimentalEnabled` is the owner-approved, provider-scoped list; absent
 *  means none. An unregistered provider or an unknown platform resolves
 *  disabled, never throws: a feature asking gets "no". */
export function providerCapability(
  id: ProviderId,
  key: CapabilityKey,
  opts: { platform?: CapabilityPlatform; experimentalEnabled?: readonly ScopedCapabilityKey[] } = {},
): CapabilityResolution {
  const platform = opts.platform ?? process.platform
  return resolveCapability(packages.get(id)?.capabilities, key, {
    providerId: id,
    platform: (isCapabilityPlatform(platform) ? platform : 'unknown') as CapabilityPlatform,
    experimentalEnabled: opts.experimentalEnabled,
  })
}

/** The launch-path API for the realm environment (D3): the policy comes from
 *  the registered package, never from the caller, so a launch cannot opt out
 *  of the ambient-variable removal. */
export function realmEnvForProvider(id: ProviderId, base: Readonly<Record<string, string | undefined>>, patch: RealmEnvPatch): Record<string, string> {
  const pkg = getProviderPackage(id)
  return applyRealmEnvPatch(base, patch, { ambientAuthVariables: pkg.ambientAuthVariables, ownedVariables: pkg.ownedLaunchVariables })
}

/** Test-only: clear both views. */
export function _resetProviderRegistryForTest(): void {
  sessions.clear()
  packages.clear()
}
