// WP1 provider core (main): the provider registry.
//
// Two views over one registration: the session-provider registry the runtime
// already uses (`getProvider('claude')` from pty-manager and boot), and the
// package registry WP1 adds (capabilities, ambient/owned variables, setup/
// auth/realm operations). Only the composition root (`../compose.ts`)
// registers packages; this module imports no concrete provider.
import type {
  ProviderId, RealmEnvPatch, SanitizedManagedSettings, ManagedLaunchPreflightInput, ManagedLaunchPreflight,
} from '../../../shared/providers'
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
  const ml = pkg.managedLaunch
  if (ml !== undefined) {
    if (typeof ml !== 'object' || ml === null) return 'managedLaunch must be an object when present'
    if (typeof ml.minimumCliVersion !== 'string' || !ml.minimumCliVersion) return 'managedLaunch.minimumCliVersion must be declared'
    for (const fn of ['sanitizeManagedSettings', 'preflight', 'authoritySettingsKeys'] as const) {
      if (typeof ml[fn] !== 'function') return `managedLaunch.${fn}() must be a function`
    }
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
  return applyRealmEnvPatch(base, patch, {
    ambientAuthVariables: pkg.ambientAuthVariables,
    ownedVariables: pkg.ownedLaunchVariables,
  })
}

/** The ambient authority variables a provider declares. A READ, for a launch
 *  path that needs to REPORT what the removal pass took out -- the removal
 *  itself happens inside `realmEnvForProvider` and nowhere else. Returns a
 *  copy. */
export function ambientAuthVariablesForProvider(id: ProviderId): readonly string[] {
  return [...getProviderPackage(id).ambientAuthVariables]
}

/** Sanitise a settings file the app writes into a managed realm.
 *
 *  FAILS CLOSED on an UNREGISTERED provider. The distinction matters and is
 *  not pedantry: "registered, and declares no sanitiser" is a provider saying
 *  it has no app-owned settings file, so the text passes through. "Not
 *  registered" means the composition root has not run, which is a boot-order
 *  fault -- and passing the text through there would write an UNSANITISED
 *  settings file into a managed realm, the exact hole this slice closes. The
 *  caller must not write anything when `text` is null. */
export function sanitizeManagedSettingsFor(id: ProviderId, raw: string): SanitizedManagedSettings {
  const pkg = tryGetProviderPackage(id)
  if (!pkg) {
    return { text: null, removed: [], refused: `provider package "${id}" is not registered, so its settings sanitiser is unavailable` }
  }
  return pkg.managedLaunch ? pkg.managedLaunch.sanitizeManagedSettings(raw) : { text: raw, removed: [] }
}

/** The authority-bearing keys a settings payload contains, for a file the app
 *  does not own.
 *
 *  NULL when there is nobody to ask -- the provider is not registered, or
 *  declares no managed-launch hardening. That is deliberately distinct from an
 *  empty list, for the same reason `sanitizeManagedSettingsFor` separates the
 *  two: an unregistered provider is a boot-order fault, and reporting it as
 *  "this project carries no authority settings" would be an answer the data
 *  does not support (adversarial re-attack, MINOR). */
export function authoritySettingsKeysFor(id: ProviderId, raw: string): readonly string[] | null {
  const ml = tryGetProviderPackage(id)?.managedLaunch
  return ml ? ml.authoritySettingsKeys(raw) : null
}

/** Run a provider's managed-launch preflight. An unregistered provider, or one
 *  with no hardening to offer, cannot be reported on -- the caller gets null
 *  and must not read that as a pass. */
export function managedLaunchPreflightFor(id: ProviderId, input: ManagedLaunchPreflightInput): ManagedLaunchPreflight | null {
  const ml = tryGetProviderPackage(id)?.managedLaunch
  return ml ? ml.preflight(input) : null
}

/** The oldest CLI version this provider's host controls have been proven on,
 *  or null when it declares no floor. */
export function minimumManagedCliVersionFor(id: ProviderId): string | null {
  return tryGetProviderPackage(id)?.managedLaunch?.minimumCliVersion ?? null
}

/** Test-only: clear both views. */
export function _resetProviderRegistryForTest(): void {
  sessions.clear()
  packages.clear()
}
