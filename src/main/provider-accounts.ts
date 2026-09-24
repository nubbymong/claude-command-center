// WP2 commit 3: the accounts service at runtime. Provider core owns the rules
// (src/main/providers/core/accounts-service.ts); this module supplies the
// real settings, the one lease registry, the one secret store and the
// registered packages, and runs the one-time adoption of a provider's own
// default sign-in after the legacy reconcile at start.
import { randomBytes } from 'node:crypto'
import { AccountsService, SecretHandleStore, listProviderPackages } from './providers/core'
import type { ProviderEnablementSpec } from './providers/core'
import { isCapabilityKey, isProviderId } from '../shared/providers'
import type { ProviderId, ProviderPreference, ScopedCapabilityKey, CapabilityPlatform } from '../shared/providers'
import {
  getAccountRegistry, getAccountRegistryResourcesDir, getConsumerLeases, initAccountRegistry, reconcileLegacyAccountStore, reconcileLegacyAccountStores,
  sameDirectory,
} from './provider-account-registry'
import { readConfigChecked } from './config-manager'
import { logInfo, logError } from './debug-logger'

/** The one-shot secret store behind API-key sign-in (A6). A monotonic
 *  clock: a wall-clock change neither shortens nor extends a handle. */
const secrets = new SecretHandleStore({ now: () => performance.now() })

/** The provider package takes a deposited key here, once, by handle. */
export function takeProviderSecret(handle: string): string | null {
  return secrets.take(handle)
}

let service: AccountsService | null = null

/** The saved settings, or null when they cannot be read (never "none"). */
function readSettings(): Record<string, unknown> | null {
  const r = readConfigChecked<Record<string, unknown>>('settings', { quarantineUnparseable: false })
  if (r.outcome === 'absent') return {}
  if (r.outcome !== 'ok' || !r.value || typeof r.value !== 'object') return null
  return r.value
}

/** Three-way, as saved, by the package's own enablement data: true is on,
 *  false is off, absent is what the package says (Codex: not answered yet,
 *  since installation alone is never consent; Claude: on). Unreadable
 *  settings are no answer, never a yes. A package without the data is on. */
export function providerPreferenceFromSettings(spec: ProviderEnablementSpec | undefined, settings: Record<string, unknown> | null): ProviderPreference {
  if (!spec) return 'on'
  if (settings === null) return 'undecided'
  const v = Object.hasOwn(settings, spec.settingsKey) ? settings[spec.settingsKey] : undefined
  return v === true ? 'on' : v === false ? 'off' : spec.absent
}

/** Throws when the saved settings cannot be read: the service then keeps
 *  the last value it read (no answer is never a yes). */
function preferenceOf(providerId: ProviderId): ProviderPreference {
  const pkg = listProviderPackages().find((p) => p.id === providerId)
  const settings = readSettings()
  if (settings === null && pkg?.enablement) throw new Error('the settings could not be read')
  return providerPreferenceFromSettings(pkg?.enablement, settings)
}

/** Owner-enabled experimental capabilities: a provider-scoped allowlist in
 *  settings; anything malformed is ignored. */
export function experimentalFromSettings(settings: Record<string, unknown> | null): ScopedCapabilityKey[] {
  const raw = settings?.experimentalCapabilities
  if (!Array.isArray(raw)) return []
  return raw.filter((v): v is ScopedCapabilityKey => {
    if (typeof v !== 'string') return false
    const i = v.indexOf(':')
    return i > 0 && isProviderId(v.slice(0, i)) && isCapabilityKey(v.slice(i + 1))
  })
}

/** Build the service once the registry has been loaded (or failed to). */
export function initProviderAccounts(): AccountsService {
  service = new AccountsService({
    // Asked afresh each time: a resources-directory change re-creates it.
    store: () => getAccountRegistry(),
    leases: getConsumerLeases(),
    secrets,
    packages: () => listProviderPackages(),
    preference: preferenceOf,
    experimentalEnabled: () => experimentalFromSettings(readSettings()),
    platform: process.platform as CapabilityPlatform,
    randomHex: () => randomBytes(16).toString('hex'),
    reconcileLegacy: (id) => reconcileLegacyAccountStore(id),
    log: (m) => logInfo(m),
  })
  return service
}

export function getAccountsService(): AccountsService | null {
  return service
}

/** The one-time adoption of each provider's own default sign-in, after the
 *  registry load and the legacy reconcile, outside the registry lock. */
export async function runStartupProviderMigrations(): Promise<void> {
  const s = service
  if (!s) return
  for (const pkg of listProviderPackages()) {
    if (!pkg.externalDefaultRealm) continue
    try {
      const r = await s.migrateExternalDefault(pkg.id)
      logInfo(`[accounts] ${pkg.id} external default at start: ${r.ok ? r.outcome : r.code}`)
    } catch (e) {
      logError(`[accounts] ${pkg.id} external default at start threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

/** The resources directory changed while the app runs (the first-run setup
 *  chooses it after start). The registry's file port captured the old one,
 *  so it is loaded again from the new one, with the same start-up work --
 *  the legacy reconcile, then the one-time adoption -- before anything
 *  reads or reconciles it. The service follows the new store by itself. */
export async function followResourcesDirectory(resourcesDir: string): Promise<void> {
  const loaded = getAccountRegistryResourcesDir()
  // The same folder spelled another way (case, a trailing separator, a link)
  // is no change: a second store over one file would have its own lock.
  if (!resourcesDir || (loaded !== null && sameDirectory(loaded, resourcesDir))) return
  try {
    initAccountRegistry(resourcesDir)
    await reconcileLegacyAccountStores()
    await runStartupProviderMigrations()
  } catch (e) {
    logError(`[accounts] following the resources directory failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export function _resetProviderAccountsForTest(): void {
  service = null
}
