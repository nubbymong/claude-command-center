// WP2 commit 3: the accounts service at runtime. Provider core owns the rules
// (src/main/providers/core/accounts-service.ts); this module supplies the
// real settings, the one lease registry, the one secret store and the
// registered packages, and runs the start-up work after the legacy reconcile
// (never an adoption of a provider's own default sign-in: see
// runStartupProviderMigrations).
import { randomBytes } from 'node:crypto'
import { AccountsService, SecretHandleStore, listProviderPackages } from './providers/core'
import type { ProviderEnablementSpec } from './providers/core'
import { isCapabilityKey, isProviderId } from '../shared/providers'
import type { ProviderId, ProviderPreference, ScopedCapabilityKey, CapabilityPlatform } from '../shared/providers'
import {
  accountRegistryLoadSettled, getAccountRegistry, getAccountRegistryResourcesDir, getConsumerLeases, initAccountRegistry, reconcileLegacyAccountStore,
  reconcileLegacyAccountStores, sameDirectory,
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
 *  since installation alone is never consent; Claude: on). A package that
 *  declares an answered key has an answer only once that key is saved true
 *  (Codex: `codexAnswered`); until then its saved on/off is ignored, and it
 *  reads as absent (owner decision 2026-09-26: an earlier build's Codex
 *  setting does not carry over). Unreadable settings are no answer, never a
 *  yes. A package without the data is on. */
export function providerPreferenceFromSettings(spec: ProviderEnablementSpec | undefined, settings: Record<string, unknown> | null): ProviderPreference {
  if (!spec) return 'on'
  if (settings === null) return 'undecided'
  if (spec.answeredKey !== undefined && !(Object.hasOwn(settings, spec.answeredKey) && settings[spec.answeredKey] === true)) return spec.absent
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

/** Whether the provider is on now: as the accounts service answers it (a
 *  switch made there, else the saved setting), or before the service exists
 *  the saved setting by the package's own enablement data. Not answered yet
 *  is not on, and neither is anything while the saved settings cannot be
 *  read: this fails closed where the service keeps the last value it read
 *  (no answer is never a yes). For work that only runs while a provider is
 *  on (its status page, P3.4). */
export function providerOnNow(providerId: ProviderId): boolean {
  try {
    if (readSettings() === null) return false
    return (service ? service.preferenceOf(providerId) : preferenceOf(providerId)) === 'on'
  } catch {
    return false
  }
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

/** Build the service once the registry has been loaded (or failed to).
 *  `unleasedSessions` and `legacyRecordInUse` come from the composition
 *  root (pty-manager, the Claude session identities), so this module imports
 *  no PTY or provider session code. */
export function initProviderAccounts(opts: {
  unleasedSessions?: (providerId: ProviderId) => number
  legacyRecordInUse?: (providerId: ProviderId, legacyId: string) => boolean
} = {}): AccountsService {
  service = new AccountsService({
    ...(opts.unleasedSessions ? { unleasedSessions: opts.unleasedSessions } : {}),
    ...(opts.legacyRecordInUse ? { legacyRecordInUse: opts.legacyRecordInUse } : {}),
    // Asked afresh each time: a resources-directory change re-creates it.
    store: () => getAccountRegistry(),
    // Once the load has run, a registry missing or unloaded (its load threw)
    // can never be read: the usage index is then told no folders.
    registrySettled: () => accountRegistryLoadSettled(),
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

/** The start-up work after the registry load and the legacy reconcile,
 *  outside the registry lock. It does NOT adopt a provider's own default
 *  sign-in (Codex's own home folder): that is only
 *  ever taken in by the user's explicit choice, "Use this sign-in" on the
 *  Set up Codex page or "Use this computer's Codex sign-in" in Settings,
 *  Accounts (owner decision 2026-09-26). The one-time start-up adoption that
 *  ran here is gone. */
export async function runStartupProviderMigrations(): Promise<void> {
  const s = service
  if (!s) return
  // A check or an adoption of that sign-in that an earlier run left
  // unfinished is dropped: nothing resumes it, and it would read as in use.
  try {
    await s.dropLeftoverExternalReservations()
  } catch (e) {
    logError(`[accounts] dropping unfinished checks of a provider's own sign-in threw: ${e instanceof Error ? e.message : String(e)}`)
  }
  // An old sign-in a sign in again left when the app closed is settled
  // (P3.3 review round 1, Q2), by the same rule as after the switch.
  try {
    await s.settleLeftoverSignIns()
  } catch (e) {
    logError(`[accounts] settling an old sign-in left at start threw: ${e instanceof Error ? e.message : String(e)}`)
  }
  // A reviewer choice this platform can never use is cleared, and said so.
  try {
    await s.clearUnusableReviewerDefaults()
  } catch (e) {
    logError(`[accounts] clearing unusable reviewer defaults threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Once at start: look for the CLI of every provider that is switched on, in
 *  the background (the service decides which; see discoverAtStart). Without
 *  it a provider's status reads "not checked yet" until some operation or a
 *  click on Check again looks. Never throws and never waits. */
export function discoverProvidersAtStart(): void {
  try {
    service?.discoverAtStart()
  } catch (e) {
    logError(`[accounts] provider discovery at start threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** The resources directory changed while the app runs (the first-run setup
 *  chooses it after start). The registry's file port captured the old one,
 *  so it is loaded again from the new one, with the same start-up work --
 *  the legacy reconcile, then runStartupProviderMigrations -- before anything
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
