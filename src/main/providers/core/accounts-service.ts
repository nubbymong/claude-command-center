// WP2 commit 3: the accounts service (design 5.6, 9.2, 9.3, 10, 11, 13; plan
// A4, A6, A11). The one place the Accounts surface's requests become registry
// changes and provider operations. Provider-neutral: it sees providers only
// through the package contract (setup, auth, realmFolders,
// externalDefaultRealm, capabilities), and a provider that does not offer an
// operation gets "unsupported" -- Claude keeps its own sign-in and account
// flows unchanged (A12).
//
// Rules it keeps:
// - Everything the renderer receives is a view: opaque ids, states, labels,
//   counts. No path, pathRef, executable, environment value, token, key or
//   provider subject leaves this module (the snapshot builder is the only
//   producer of renderer data, and it copies named fields only).
// - Every change that could pull an account out from under a consumer reads
//   the consumer count under the registry lock that applies it; sign-out and
//   archive take the account exclusively for their whole run, so nothing can
//   start on it meanwhile.
// - Every lease this service takes is released in a finally: a failure, a
//   cancellation and a destroyed renderer all end the same way.
// - A failed provider operation changes only its own provider's records.
// - Capabilities gate every sign-in method, status and sign-out, on every
//   path that runs one (setup, completion, abandon, archive, reactivation,
//   adoption, reconcile): unknown is off; experimental is off until the
//   owner enables it for that provider. A provider switched off runs no CLI.
// - An archived account, or one whose realm is no longer active, runs
//   nothing: its record may name a home a live account now uses.
import {
  beginAccountSetup, abandonAccountSetup, commitAccountSetup, markSetupCredentialsWritten, createIdentity, updateIdentity,
  createGroup, renameGroup, deleteGroup, linkAccountIdentity, unlinkAccountIdentity, setAccountLifecycle, setProviderDefault,
  recordAuthCheck, reconcileAccountSignIn, resolveIdentityConflict, setReviewerDefault, chooseReviewerAccount, chooseSessionAccount,
  recordProviderMigration, resolveLaunchBinding, findAccount, findRealm, findIdentity, isLegacyLinked,
  resolveCapability, makeOpaqueId, providerRealmKind, isIdentityColourKey,
  MANAGED_PATH_REF_PREFIX, EXTERNAL_DEFAULT_PATH_REF, SIGN_IN_METHODS, SIGN_IN_CAPABILITY, providerOffMessage, providerStateUnknownMessage,
} from '../../../shared/providers'
import type {
  ProviderId, ProviderRegistryDoc, RegistryResult, AuthMethod, KnownAuthState, AccountLifecycle, SessionBinding,
  CapabilityKey, CapabilityPlatform, ScopedCapabilityKey, ProviderPreference, SignInMethod, AccountsSnapshot, AccountsFailure,
  AccountsFailureCode, AccountsResult, AccountView, ProviderInstallationView, CapabilityView, PendingSetupView, ExternalDefaultView,
  SetupIdentityChoice, IdentityPatch, RegistryModeView, InstallRecipeView, ExternalDefaultOutcome, CredentialClass,
  ResolveConflictRequest, SetReviewerDefaultRequest, ReviewerChoice, ReviewRefusalView, ReviewReadinessView, ProviderLaunchRefusal,
} from '../../../shared/providers'
import type { ProviderPackage, DiscoveryResult, AuthCredentialKind, AuthOperationResult, InstallRecipe } from './package'
import type { AccountRegistryStore, StoreResult } from './account-registry-store'
import type { ConsumerLeaseRegistry, AccountLease, LaunchLeaseKind } from './consumer-leases'
import { LAUNCH_LEASE_KINDS } from './consumer-leases'
import type { SecretHandleStore } from './secret-handles'
import { migrateExternalDefaultRealm } from './external-default-migration'
import { realmEnvForProvider } from './registry'
import { recipeRunLine } from './recipe-run-line'
import type { ExternalDefaultMigrationOutcome } from './external-default-migration'

export interface AccountsServiceDeps {
  /** The registry of the app's CURRENT resources directory, asked afresh
   *  for every operation (the runtime re-creates it when the directory
   *  changes). Null when there is none (nothing to manage). */
  store: () => AccountRegistryStore | null
  leases: ConsumerLeaseRegistry
  secrets: SecretHandleStore
  packages: () => readonly ProviderPackage[]
  /** The durable preference as the user last saved it. A throw means the
   *  saved setting could not be read: no answer, never a yes -- the last
   *  value read stands. */
  preference: (providerId: ProviderId) => ProviderPreference
  /** Owner-enabled experimental capabilities, provider-scoped. */
  experimentalEnabled?: () => readonly ScopedCapabilityKey[]
  platform: CapabilityPlatform
  /** 32 lowercase hex characters of fresh randomness. */
  randomHex: () => string
  /** Push an identity edit to the legacy store that mirrors it (Claude's
   *  profiles.json) now, rather than at the next start. */
  reconcileLegacy?: (providerId: ProviderId) => Promise<void>
  /** How much of a provider runs holding no account lease -- Claude's
   *  sessions, until its launch path takes one, and whatever else runs its
   *  CLI without one (the composition root decides what counts): a
   *  switch-off refuses while any runs. A throw counts as running (fail
   *  closed). */
  unleasedSessions?: (providerId: ProviderId) => number
  log?: (message: string) => void
}

/** A launch's hold on its account: an interactive session (commit 4) or a
 *  reviewer invocation (commit 5), bound the same way. */
export type LaunchLeaseResult =
  | { ok: true; lease: AccountLease; binding: SessionBinding; realmOnly: boolean; reviewer?: ReviewerChoice }
  | AccountsFailure

/** Everything a launch runs with, bound and held (plan A10): the lease the
 *  launch's end releases, the binding, and the provider's preparation. The
 *  environment already has the ambient authority variables removed and the
 *  realm selector set last; a caller adds only its own session variables. */
export type PreparedLaunchResult =
  | {
    ok: true
    lease: AccountLease
    binding: SessionBinding
    realmOnly: boolean
    reviewer?: ReviewerChoice
    home: string
    executable: string
    env: Record<string, string>
    sessionsDir: string
  }
  | AccountsFailure

/** The kind of credential a status reported, as the registry compares it. */
function observedCredential(credential: AuthCredentialKind | undefined): CredentialClass | undefined {
  return credential === 'account' || credential === 'api-key' ? credential : undefined
}

const FAIL_MESSAGES: Partial<Record<AccountsFailureCode, string>> = {
  'registry-unavailable': 'The account list is not available right now.',
  'unsupported': 'This provider does not offer that here.',
  'capability-disabled': 'That is not available for this provider yet.',
  'provider-disabled': 'This provider is turned off.',
  'last-provider': 'At least one provider must stay on.',
  'consumers': 'Sessions or operations are using this account.',
  'busy': 'Something else is using this account right now; try again when it finishes.',
  'acknowledgement-required': 'This sign-in is shared with other apps on this computer; confirm to continue.',
  'not-signed-in': 'This account is not signed in.',
  'secret-unavailable': 'The key was not received; enter it again.',
  'sign-in-changed': 'This account now holds a different sign-in than before. Review it in Accounts and confirm it before continuing.',
  'review-unavailable': 'This account cannot run reviews on this computer.',
  'realm-only': 'An unverified sign-in needs your confirmation each time, so it cannot be used unattended.',
  'not-found': 'That account or setup no longer exists.',
  'invalid-request': 'That request was not valid.',
}

/** A package's platform review rule for one realm (see reviewRefusalOf). */
type PlatformReviewRule = { kind: 'allowed' } | { kind: 'refused'; message: string } | { kind: 'unknown' }

function failure(code: AccountsFailureCode, message?: string, extra: { consumers?: number; state?: KnownAuthState } = {}): AccountsFailure {
  return { ok: false, code, message: message ?? FAIL_MESSAGES[code] ?? 'That did not work.', ...extra }
}

/** The launch kinds a package prepares, as it declares them; a declaration
 *  that is not a list of known kinds prepares nothing (fail closed). */
function launchKindsOf(p: ProviderPackage): readonly LaunchLeaseKind[] {
  const kinds: unknown = p.launch?.kinds
  return Array.isArray(kinds) ? kinds.filter((k): k is LaunchLeaseKind => (LAUNCH_LEASE_KINDS as readonly unknown[]).includes(k)) : []
}

/** Chain transitions; the first refusal is the result. */
function chain(doc: ProviderRegistryDoc, steps: ReadonlyArray<(d: ProviderRegistryDoc) => RegistryResult>): RegistryResult {
  let cur = doc
  for (const step of steps) {
    const r = step(cur)
    if (!r.ok) return r
    cur = r.doc
  }
  return { ok: true, doc: cur }
}

function methodFromCredential(credential: AuthCredentialKind | undefined, signedInWith: SignInMethod | undefined): AuthMethod {
  if (credential === 'api-key') return 'apiKey'
  // A provider-account sign-in: the flow this app ran, else the browser flow
  // (the CLI names the kind, not the flow) -- never "unknown", which would
  // leave the next check nothing to compare.
  if (credential === 'account') return signedInWith === 'device' ? 'device' : 'browser'
  return signedInWith ?? 'unknown'
}

const EXTERNAL_IDENTITY_COLOUR = 'slate-blue'

interface SignInRun {
  controller: AbortController
  senderId: number
  /** The API-key handle this run will hand the package, if any. */
  handle?: string
}

/** A provider on/off the user chose here, held until the saved setting
 *  catches up -- or until the saved setting changes some other way. */
interface EnabledOverride {
  enabled: boolean
  /** The saved preference when the override was set. */
  savedAtSet: ProviderPreference
}

export class AccountsService {
  private revision = 0
  private readonly listeners = new Set<() => void>()
  private readonly enabledOverride = new Map<ProviderId, EnabledOverride>()
  /** The last preference each provider's saved setting read as. */
  private readonly lastSaved = new Map<ProviderId, ProviderPreference>()
  private readonly installations = new Map<ProviderId, DiscoveryResult>()
  private readonly signIns = new Map<string, SignInRun>()
  private readonly signedInWith = new Map<string, SignInMethod>()
  // Typed by the shared view union: a core outcome it lacks fails to compile.
  private readonly migrationRuns = new Map<ProviderId, ExternalDefaultOutcome>()
  /** Reviewer choices cleared at start-up because they can never run here
   *  (clearUnusableReviewerDefaults); shown once, removed by a new choice. */
  private readonly reviewerNotices = new Map<ProviderId, { message: string; store: AccountRegistryStore }>()
  /** Accounts signed in again whose new sign-in could not be recorded: they
   *  are refused for launches until a later check records (signInAgain,
   *  refreshStatus, reconcileSignIn). In memory only: a restart forgets it,
   *  and the record is then what it was before (a rare write failure). */
  private readonly unrecordedSignIns = new Map<string, CredentialClass | undefined>()
  /** Discoveries running now, by provider (discoverOnce joins one). */
  private readonly discoveries = new Map<ProviderId, Promise<DiscoveryResult>>()
  /** Status checks running now, by account (refreshStatus joins one). */
  private readonly statusChecks = new Map<string, Promise<AccountsResult<{ state: KnownAuthState }>>>()
  private opSeq = 0
  private subscribedStore: AccountRegistryStore | null = null
  private unsubscribeStore: (() => void) | null = null

  constructor(private readonly deps: AccountsServiceDeps) {
    this.currentStore()
    deps.leases.subscribe(() => this.changed())
  }

  /** The registry for the current resources directory, subscribed once per
   *  store object: a re-created store is followed, and the one it replaced
   *  is no longer listened to. */
  private currentStore(): AccountRegistryStore | null {
    let s: AccountRegistryStore | null
    try { s = this.deps.store() } catch { s = null }
    if (s !== this.subscribedStore) {
      try { this.unsubscribeStore?.() } catch { /* never breaks the service */ }
      this.unsubscribeStore = s ? s.subscribe(() => this.changed()) : null
      const replaced = this.subscribedStore !== null
      this.subscribedStore = s
      if (replaced) this.changed()
    }
    return s
  }

  /** Notified after anything the snapshot shows has changed. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** The preference in force. A switch made here is held until the saved
   *  setting reads back the same, and it fails closed: a switch-OFF made
   *  here stands until then, whatever else is saved meanwhile; a switch-ON
   *  made here gives way to any saved "off" and to any other change since.
   *  A read that fails says nothing: it neither clears a switch nor turns a
   *  provider back on (the last value read stands). */
  preferenceOf(providerId: ProviderId): ProviderPreference {
    return this.preferenceFrom(providerId, this.savedPreference(providerId))
  }

  /** preferenceOf, from a saved preference already read. */
  private preferenceFrom(providerId: ProviderId, saved: { pref: ProviderPreference; fresh: boolean }): ProviderPreference {
    const o = this.enabledOverride.get(providerId)
    if (o === undefined) return saved.pref
    const mine: ProviderPreference = o.enabled ? 'on' : 'off'
    if (!saved.fresh) return mine
    if (saved.pref === mine) {
      this.enabledOverride.delete(providerId)
      return saved.pref
    }
    if (!o.enabled) return mine
    if (saved.pref === 'off' || saved.pref !== o.savedAtSet) {
      this.enabledOverride.delete(providerId)
      return saved.pref
    }
    return mine
  }

  private savedPreference(providerId: ProviderId): { pref: ProviderPreference; fresh: boolean } {
    try {
      const p = this.deps.preference(providerId)
      const pref: ProviderPreference = p === 'on' || p === 'off' ? p : 'undecided'
      this.lastSaved.set(providerId, pref)
      return { pref, fresh: true }
    } catch {
      return { pref: this.lastSaved.get(providerId) ?? 'undecided', fresh: false }
    }
  }

  /** Enabled unless explicitly off: an existing user who never answered
   *  keeps working as before (the migration alone waits for an answer). */
  isEnabled(providerId: ProviderId): boolean {
    return this.preferenceOf(providerId) !== 'off'
  }

  /** Why a launch of this provider may not start now, or null when it may:
   *  the one rule every path that starts a provider's CLI for the user asks
   *  (through src/main/provider-launch-gate.ts), before any process starts.
   *  The preference in force decides, as isEnabled does: off refuses, while
   *  on and not-answered-yet do not (a user who never answered keeps
   *  launching, as prepareLaunch has always allowed). One difference: a
   *  saved setting that cannot be read NOW refuses. The last value read
   *  stands for the Accounts surface; for starting a process, no answer is
   *  never a yes. A provider this app does not know refuses too. */
  launchRefusal(providerId: ProviderId): ProviderLaunchRefusal | null {
    const p = this.pkg(providerId)
    if (!p) return { code: 'provider-state-unknown', providerId, message: providerStateUnknownMessage(String(providerId)) }
    const saved = this.savedPreference(providerId)
    if (this.preferenceFrom(providerId, saved) === 'off') return { code: 'provider-off', providerId, message: providerOffMessage(p.displayName) }
    if (!saved.fresh) return { code: 'provider-state-unknown', providerId, message: providerStateUnknownMessage(p.displayName) }
    return null
  }

  snapshot(): AccountsSnapshot {
    const store = this.currentStore()
    const status = store?.status()
    const registry: RegistryModeView = !store || !status ? { mode: 'unavailable' } : status.mode === 'ready' ? { mode: 'ready' } : { mode: 'recovery', reason: status.reason }
    const doc = store && status?.mode === 'ready' ? store.current() : null
    const packages = this.deps.packages()
    // One read of each realm's platform rule for the whole snapshot.
    const memo = new Map<string, PlatformReviewRule>()
    const accounts: AccountView[] = (doc?.accounts ?? []).map((a) => {
      const realm = doc ? findRealm(doc, a.authRealmId) : undefined
      const external = realm?.ownership === 'external-default'
      const view: AccountView = {
        id: a.id,
        providerId: a.providerId,
        identityId: a.identityId,
        lifecycle: a.lifecycle,
        isProviderDefault: a.isProviderDefault,
        isReviewerDefault: a.isReviewerDefault === true,
        authMethod: a.authMethod,
        lastKnownAuthState: a.lastKnownAuthState,
        operationalState: a.operationalState,
        identityAssurance: a.identityAssurance,
        realmLifecycle: realm ? realm.lifecycle : 'missing',
        external,
        unverified: a.identityAssurance === 'realm-only' || external,
        legacyLinked: doc ? isLegacyLinked(doc, a.id) : false,
        runningSessions: this.deps.leases.runningSessions(a.id),
        runningReviews: this.deps.leases.countKind(a.id, 'review'),
        consumers: this.deps.leases.count(a.id),
      }
      if (a.providerLabel !== undefined) view.providerLabel = a.providerLabel
      if (a.planLabel !== undefined) view.planLabel = a.planLabel
      if (a.lastAuthenticatedAt !== undefined) view.lastAuthenticatedAt = a.lastAuthenticatedAt
      if (a.lastValidatedAt !== undefined) view.lastValidatedAt = a.lastValidatedAt
      const legacyId = doc?.legacyLinks.find((l) => l.accountId === a.id)?.legacyId
      if (legacyId !== undefined) view.legacyId = legacyId
      const refusal = doc ? this.reviewRefusalOf(doc, a, memo) : undefined
      if (refusal) view.reviewRefusal = refusal
      return view
    })
    const pendingSetups: PendingSetupView[] = (doc?.journals ?? []).map((j) => ({
      accountId: j.accountId,
      providerId: j.providerId,
      method: j.method,
      state: j.state,
      external: doc ? findRealm(doc, j.realmId)?.ownership === 'external-default' : false,
      createdAt: j.createdAt,
      signingIn: this.signIns.has(j.accountId),
    }))
    const externalDefaults: ExternalDefaultView[] = packages.filter((p) => p.externalDefaultRealm).map((p) => {
      const m = doc?.migrations.find((x) => x.providerId === p.id && x.step === 'external-default')
      const view: ExternalDefaultView = { providerId: p.id, needsConfirmation: !m && this.preferenceOf(p.id) === 'undecided' }
      if (m) view.marker = { outcome: m.outcome, at: m.at, ...(m.reason ? { reason: m.reason } : {}) }
      const run = this.migrationRuns.get(p.id)
      if (run) view.lastRun = run
      return view
    })
    return {
      revision: this.revision,
      registry,
      providers: packages.map((p) => {
        const view = this.installationView(p)
        const review = this.reviewReadiness(p, doc, memo)
        return review ? { ...view, review } : view
      }),
      identities: (doc?.identities ?? []).map((i) => ({ id: i.id, colourKey: i.colourKey, ...(i.friendlyName !== undefined ? { friendlyName: i.friendlyName } : {}), ...(i.groupId !== undefined ? { groupId: i.groupId } : {}) })),
      groups: (doc?.groups ?? []).map((g) => ({ id: g.id, name: g.name, order: g.order })),
      accounts,
      pendingSetups,
      externalDefaults,
      // Named fields only: display labels, palette keys and ids.
      conflicts: (doc?.conflicts ?? []).map((c) => ({
        identityId: c.identityId, field: c.field, providerId: c.providerId, legacyId: c.legacyId,
        legacyValue: c.legacyValue, registryValue: c.registryValue, detectedAt: c.detectedAt,
      })),
      // Only the notices this registry produced: a resources directory chosen
      // later is another registry, with its own reviewer choices.
      reviewerNotices: [...this.reviewerNotices].filter(([, n]) => n.store === store).map(([providerId, n]) => ({ providerId, message: n.message })),
    }
  }

  private installationView(p: ProviderPackage): ProviderInstallationView {
    const d = this.installations.get(p.id)
    const cap = (key: CapabilityKey): CapabilityView => {
      const r = this.capability(p, key)
      return { enabled: r.enabled, labelExperimental: r.labelExperimental }
    }
    const view: ProviderInstallationView = {
      providerId: p.id,
      displayName: p.displayName,
      enabled: this.isEnabled(p.id),
      preference: this.preferenceOf(p.id),
      discoveryState: d?.state ?? 'unchecked',
      compatibility: d?.compatibility ?? 'unknown',
      managedAccounts: this.managesAccounts(p),
      signInMethods: { browser: cap('auth.browser'), device: cap('auth.device'), apiKey: cap('auth.apiKey') },
      status: cap('auth.status'),
      logout: cap('auth.logout'),
    }
    if (d?.version !== undefined) view.version = d.version
    if (d?.checkedAt !== undefined) view.lastCheckedAt = d.checkedAt
    return view
  }

  private capability(p: ProviderPackage, key: CapabilityKey) {
    let experimental: readonly ScopedCapabilityKey[] = []
    try { experimental = this.deps.experimentalEnabled?.() ?? [] } catch { experimental = [] }
    return resolveCapability(p.capabilities, key, { providerId: p.id, platform: this.deps.platform, experimentalEnabled: experimental })
  }

  private managesAccounts(p: ProviderPackage): boolean {
    return !!p.auth && !!p.realmFolders && providerRealmKind(p.id) !== null
  }

  private pkg(providerId: ProviderId): ProviderPackage | null {
    return this.deps.packages().find((p) => p.id === providerId) ?? null
  }

  private changed(): void {
    this.revision++
    for (const l of this.listeners) {
      try { l() } catch { /* a listener never breaks the service */ }
    }
  }

  /** The saved settings changed (the app's own settings save): a provider's
   *  saved on/off may have, and it wins over an in-memory switch, so the
   *  snapshot is published again with what the service now answers. */
  settingsChanged(): void {
    this.changed()
  }

  private log(m: string): void {
    try { this.deps.log?.(`[accounts] ${m}`) } catch { /* never breaks the service */ }
  }

  /** The store, ready, or why not. */
  private ready(): { store: AccountRegistryStore; doc: ProviderRegistryDoc } | AccountsFailure {
    const store = this.currentStore()
    const doc = store?.current()
    if (!store || store.status().mode !== 'ready' || !doc) return failure('registry-unavailable')
    return { store, doc }
  }

  private fromStore(r: StoreResult, consumers?: number): AccountsFailure | null {
    if (r.ok) return null
    if (r.code === 'recovery') return failure('registry-unavailable')
    if (r.code === 'persist-failed') return failure('persist-failed', 'The change could not be saved.')
    if (r.code === 'blocked-by-consumers') return failure('consumers', undefined, { consumers: consumers ?? 1 })
    return failure(r.code, r.message)
  }

  private fromAuth(r: AuthOperationResult): AccountsFailure {
    const code = (r.code ?? 'provider-refused') as AccountsFailureCode
    return failure(code, typeof r.message === 'string' && r.message ? r.message : undefined, r.state ? { state: r.state } : {})
  }

  /** Ensure the provider's CLI has been proven this run: its auth operations
   *  run only the executable discovery last proved. A discovery in flight is
   *  waited for first: the package clears its proof while one runs, so an
   *  operation started meanwhile would otherwise be refused on a record that
   *  still says found. */
  private async ensureDiscovered(p: ProviderPackage): Promise<void> {
    if (!p.setup) return
    const running = this.discoveries.get(p.id)
    if (running) {
      await running
      return
    }
    if (this.installations.get(p.id)?.state === 'found') return
    await this.discoverOnce(p)
  }

  /** One discovery per provider at a time: a caller while one runs joins it,
   *  so what this service records (`installations`) and what the package
   *  proved come from the same run, whoever asked (Check again, the start-up
   *  look, an operation, the start-up migration). */
  private discoverOnce(p: ProviderPackage): Promise<DiscoveryResult> {
    const running = this.discoveries.get(p.id)
    if (running) return running
    const setup = p.setup
    const run = (async (): Promise<DiscoveryResult> => {
      let d: DiscoveryResult
      try {
        if (!setup) throw new Error('no discovery step')
        d = await setup.discover()
      } catch {
        d = { state: 'error', compatibility: 'unknown', checkedAt: Date.now() }
      }
      this.installations.set(p.id, d)
      this.changed()
      return d
    })()
    const tracked: Promise<DiscoveryResult> = run.finally(() => {
      if (this.discoveries.get(p.id) === tracked) this.discoveries.delete(p.id)
    })
    this.discoveries.set(p.id, tracked)
    return tracked
  }

  // -------------------------------------------------------------------------
  // Installation and enablement (5.6)
  // -------------------------------------------------------------------------

  async discover(providerId: ProviderId): Promise<AccountsResult<{ installation: ProviderInstallationView }>> {
    const p = this.pkg(providerId)
    if (!p?.setup) return failure('unsupported')
    await this.discoverOnce(p)
    return { ok: true, installation: this.installationView(p) }
  }

  /** Once at start, after the service is up: look for the CLI of every
   *  provider that is switched on and has a discovery step, so Settings,
   *  Accounts and the session dialog say whether it is installed without
   *  a click. Fire and forget: nothing waits for it, a failure lands in the
   *  snapshot as it does for Check again, and a provider that is off or has
   *  not been decided is not looked for (nor one already looked for). */
  discoverAtStart(): void {
    let packages: readonly ProviderPackage[]
    try { packages = this.deps.packages() } catch { return }
    for (const p of packages) {
      try {
        if (!p.setup || this.installations.has(p.id) || this.preferenceOf(p.id) !== 'on') continue
        void this.discover(p.id).catch(() => { /* discover records its own failures */ })
      } catch { /* one provider never stops another */ }
    }
  }

  /** Main's side of turning a provider on or off (A4): checked here, under
   *  the registry lock that lease acquisition takes, then held in memory as
   *  the authority for new leases until the renderer's saved setting is read
   *  back. Disabling is refused while anything of the provider runs, or when
   *  it is the last provider on. */
  async setProviderEnabled(providerId: ProviderId, enabled: boolean): Promise<AccountsResult> {
    const p = this.pkg(providerId)
    if (!p) return failure('not-found')
    const apply = (): AccountsResult => {
      if (enabled) {
        this.enabledOverride.set(providerId, { enabled: true, savedAtSet: this.savedPreference(providerId).pref })
        return { ok: true }
      }
      let unleased = 0
      try { unleased = this.deps.unleasedSessions?.(providerId) ?? 0 } catch { unleased = 1 }
      const running = this.deps.leases.countForProvider(providerId) + (Number.isSafeInteger(unleased) && unleased > 0 ? unleased : 0)
      if (running > 0) return failure('consumers', undefined, { consumers: running })
      const others = this.deps.packages().some((q) => q.id !== providerId && this.isEnabled(q.id))
      if (!others) return failure('last-provider')
      this.enabledOverride.set(providerId, { enabled: false, savedAtSet: this.savedPreference(providerId).pref })
      return { ok: true }
    }
    const store = this.currentStore()
    const r = store ? await store.exclusive(apply) : apply()
    if (r.ok) {
      this.changed()
      if (enabled) void this.discover(providerId)
    }
    return r
  }

  /** What to show and copy, and, only for a recipe main allows to run, the
   *  one shell line a terminal tab may type for it (`runLine`, decided and
   *  built here from the argv for this platform's terminal shell). Never the
   *  argv itself: the renderer neither decides what runs nor builds the line. */
  installRecipes(providerId: ProviderId): InstallRecipeView[] {
    const p = this.pkg(providerId)
    if (!p?.setup) return []
    let recipes: readonly InstallRecipe[] = []
    try { recipes = p.setup.installRecipes(this.deps.platform) } catch { return [] }
    return recipes.map((r) => {
      const runLine = recipeRunLine(r, this.deps.platform)
      return {
        id: r.id, providerId: r.providerId, purpose: r.purpose, publisher: r.publisher, sourceUrl: r.sourceUrl, displayCommand: r.displayCommand,
        method: r.method, needsNetwork: r.needsNetwork, mayElevate: r.mayElevate, autoRunAllowed: r.autoRunAllowed, ...(r.note !== undefined ? { note: r.note } : {}),
        ...(runLine !== undefined ? { runLine } : {}),
      }
    })
  }

  // -------------------------------------------------------------------------
  // Account setup (9.3)
  // -------------------------------------------------------------------------

  private methodAllowed(p: ProviderPackage, method: SignInMethod): AccountsFailure | null {
    if (!SIGN_IN_METHODS.includes(method)) return failure('invalid-request')
    return this.capability(p, SIGN_IN_CAPABILITY[method]).enabled ? null : failure('capability-disabled')
  }

  /** Reserve a managed account and create its folder before any sign-in. */
  async beginSetup(input: { providerId: ProviderId; method: SignInMethod }): Promise<AccountsResult<{ accountId: string }>> {
    const p = this.pkg(input.providerId)
    if (!p || !this.managesAccounts(p)) return failure('unsupported')
    if (!this.isEnabled(p.id)) return failure('provider-disabled')
    const refused = this.methodAllowed(p, input.method)
    if (refused) return refused
    const ready = this.ready()
    if ('ok' in ready) return ready
    const kind = providerRealmKind(p.id)!
    const accountId = makeOpaqueId('account', this.deps.randomHex())
    const realmId = makeOpaqueId('realm', this.deps.randomHex())
    const begun = await ready.store.mutate((d, t) => beginAccountSetup(d, {
      accountId, realmId, providerId: p.id, method: input.method, realmKind: kind, ownership: 'conductor-managed', pathRef: `${MANAGED_PATH_REF_PREFIX}${realmId}`,
    }, t))
    const bad = this.fromStore(begun)
    if (bad) return bad
    const prepared = await p.realmFolders!.prepare({ authRealmId: realmId }).catch(() => ({ ok: false as const, code: 'io-failed' as const }))
    if (!prepared.ok) {
      // Only an empty folder goes; anything else keeps the journal so the
      // surface can show it and the user can retry or remove it.
      const removed = await p.realmFolders!.remove({ authRealmId: realmId }, { contents: 'empty-only' }).catch(() => ({ ok: false }))
      if (removed.ok) await ready.store.mutate((d) => abandonAccountSetup(d, accountId))
      return failure((prepared.code ?? 'io-failed') as AccountsFailureCode, 'The account folder could not be prepared.')
    }
    return { ok: true, accountId }
  }

  /** A handle for the one API key this sign-in will take. */
  issueSecretHandle(input: { accountId: string }, senderId: number): AccountsResult<{ handle: string }> {
    const ready = this.ready()
    if ('ok' in ready) return ready
    // A pending setup's account, or (for "sign in again") an existing
    // managed account that is not archived.
    const j = ready.doc.journals.find((x) => x.accountId === input.accountId)
    const existing = j ? undefined : findAccount(ready.doc, input.accountId)
    if (!j && !existing) return failure('not-found')
    const p = this.pkg(j ? j.providerId : existing!.providerId)
    if (!p || !this.managesAccounts(p)) return failure('unsupported')
    if (existing && (existing.lifecycle === 'archived' || findRealm(ready.doc, existing.authRealmId)?.ownership !== 'conductor-managed')) return failure('unsupported')
    if (!this.isEnabled(p.id)) return failure('provider-disabled')
    const refused = this.methodAllowed(p, 'apiKey')
    if (refused) return refused
    const handle = this.deps.secrets.issue({ accountId: input.accountId, senderId })
    return handle ? { ok: true, handle } : failure('busy')
  }

  /** The one-way deposit. Never answers, never logs. */
  depositSecret(handle: unknown, senderId: number, secret: unknown): void {
    this.deps.secrets.deposit(handle, senderId, secret)
  }

  /** Run the provider's own sign-in in a pending setup's realm. */
  async signIn(
    input: { accountId: string; method: SignInMethod; secretHandle?: string },
    senderId: number,
    onOutput?: (text: string) => void,
  ): Promise<AccountsResult<{ state: KnownAuthState }>> {
    const handle = input.secretHandle
    // A handle is single-use: whatever this call decides, it does not stay
    // parked -- unless it is the handle a run already in flight will use (a
    // double-click must not throw away the key the first click is using).
    const burn = () => { if (handle !== undefined) this.deps.secrets.discard(handle) }
    const refuse = (r: AccountsFailure) => { burn(); return r }
    const ready = this.ready()
    if ('ok' in ready) return refuse(ready)
    const j = ready.doc.journals.find((x) => x.accountId === input.accountId)
    if (!j) return refuse(failure('not-found'))
    const p = this.pkg(j.providerId)
    const realm = findRealm(ready.doc, j.realmId)
    if (!p || !this.managesAccounts(p) || realm?.ownership !== 'conductor-managed') return refuse(failure('unsupported'))
    if (!this.isEnabled(p.id)) return refuse(failure('provider-disabled'))
    const refused = this.methodAllowed(p, input.method)
    if (refused) return refuse(refused)
    const inFlight = this.signIns.get(j.accountId)
    if (inFlight) {
      if (handle === undefined || handle !== inFlight.handle) burn()
      return failure('busy')
    }
    if (input.method === 'apiKey') {
      if (!this.deps.secrets.isBoundTo(handle, j.accountId, senderId)) return refuse(failure('secret-unavailable'))
    } else if (handle !== undefined) {
      return refuse(failure('invalid-request'))
    }
    // Claimed before any await: a second call is refused above, and a
    // renderer that goes away while this waits for the lock aborts it.
    const run: SignInRun = { controller: new AbortController(), senderId, ...(handle !== undefined ? { handle } : {}) }
    this.signIns.set(j.accountId, run)
    this.changed()
    let lease: AccountLease | null = null
    let refusal: AccountsFailure | null = null
    let result: AuthOperationResult = { ok: false, code: 'not-started' }
    try {
      const leased = await ready.store.exclusive(() => {
        if (!this.isEnabled(p.id)) return null
        // A completion (or any operation) running on this setup excludes it.
        if (this.deps.leases.countKind(j.accountId, 'operation') > 0) return { ok: false as const, code: 'held' as const }
        return this.deps.leases.add(j.accountId, j.providerId, { kind: 'sign-in', ownerId: j.accountId, webContentsId: senderId })
      })
      if (leased === null) refusal = failure('provider-disabled')
      // Never release a lease this call did not create (`existing` is another run's).
      else if (!leased.ok || leased.existing) refusal = failure('busy')
      else {
        lease = leased.lease
        if (run.controller.signal.aborted) result = { ok: false, code: 'cancelled' }
        else {
          await this.ensureDiscovered(p)
          result = await p.auth!.login({ authRealmId: j.realmId }, input.method, {
            ...(handle !== undefined ? { secretHandle: handle } : {}),
            onOutput: (text) => { try { onOutput?.(text) } catch { /* display only */ } },
            signal: run.controller.signal,
          })
        }
      }
    } catch {
      result = { ok: false, code: 'not-started' }
    } finally {
      burn()
      if (this.signIns.get(j.accountId) === run) this.signIns.delete(j.accountId)
      lease?.release()
      this.changed()
    }
    if (refusal) return refusal
    // Signed in -- also after a "failure": a cancelled sign-in may have
    // finished anyway. The journal now says credentials may exist, so an
    // interrupted setup is recovered, never silently dropped.
    if (result.state === 'signed-in') {
      // Only a login this run started signs in with its method; a realm
      // that was already signed in says nothing about how.
      if (result.code !== 'already-signed-in') this.signedInWith.set(j.accountId, input.method)
      const marked = await ready.store.mutate((d, t) => markSetupCredentialsWritten(d, j.accountId, t))
      if (!marked.ok) this.log(`could not mark a setup's credentials as written (${marked.code})`)
    }
    if (result.ok) return { ok: true, state: result.state ?? 'unknown' }
    return this.fromAuth(result)
  }

  /** Sign an existing managed account in again, in its own realm (an
   *  expired or signed-out sign-in). The provider's own login runs there,
   *  then the realm is checked and recorded exactly as a status check
   *  records it, so a different kind of sign-in blocks the account (design
   *  5.5). Refused while anything uses the account, on an external home
   *  (sign in there with the provider's own tools), and on a blocked account
   *  (the user reconciles it first). */
  async signInAgain(
    input: { accountId: string; method: SignInMethod; secretHandle?: string },
    senderId: number,
    onOutput?: (text: string) => void,
  ): Promise<AccountsResult<{ state: KnownAuthState }>> {
    const handle = input.secretHandle
    // Single-use, as for signIn: whatever this call decides, the handle does
    // not stay parked, unless a run already in flight is using it.
    const burn = () => { if (handle !== undefined) this.deps.secrets.discard(handle) }
    const refuse = (r: AccountsFailure) => { burn(); return r }
    const ctx = this.accountContext(input.accountId)
    if ('ok' in ctx) return refuse(ctx)
    const a = findAccount(ctx.doc, input.accountId)!
    const notRunnable = this.runnable(ctx, a, ['auth.status'])
    if (notRunnable) return refuse(notRunnable)
    const p = ctx.p!
    if (!this.managesAccounts(p) || ctx.external || findRealm(ctx.doc, a.authRealmId)?.ownership !== 'conductor-managed') return refuse(failure('unsupported'))
    if (a.operationalState === 'blocked') return refuse(failure('sign-in-changed'))
    const refusedMethod = this.methodAllowed(p, input.method)
    if (refusedMethod) return refuse(refusedMethod)
    const inFlight = this.signIns.get(a.id)
    if (inFlight) {
      if (handle === undefined || handle !== inFlight.handle) burn()
      return failure('busy')
    }
    if (input.method === 'apiKey') {
      if (!this.deps.secrets.isBoundTo(handle, a.id, senderId)) return refuse(failure('secret-unavailable'))
    } else if (handle !== undefined) {
      return refuse(failure('invalid-request'))
    }
    const run: SignInRun = { controller: new AbortController(), senderId, ...(handle !== undefined ? { handle } : {}) }
    this.signIns.set(a.id, run)
    this.changed()
    let lease: AccountLease | null = null
    let refusal: AccountsFailure | null = null
    let result: AuthOperationResult = { ok: false, code: 'not-started' }
    let recorded: StoreResult | null = null
    let observedClass: CredentialClass | undefined
    try {
      const leased = await ctx.store.exclusive((): { refused: AccountsFailure } | { added: ReturnType<ConsumerLeaseRegistry['add']> } => {
        if (!this.isEnabled(p.id)) return { refused: failure('provider-disabled') }
        // Nothing may be using the account while its sign-in is replaced.
        const using = this.deps.leases.count(a.id)
        if (using > 0) return { refused: failure('consumers', undefined, { consumers: using }) }
        return { added: this.deps.leases.add(a.id, a.providerId, { kind: 'sign-in', ownerId: a.id, webContentsId: senderId }) }
      })
      if ('refused' in leased) refusal = leased.refused
      // Never release a lease this call did not create.
      else if (!leased.added.ok || leased.added.existing) refusal = failure('busy')
      else {
        lease = leased.added.lease
        if (run.controller.signal.aborted) result = { ok: false, code: 'cancelled' }
        else {
          await this.ensureDiscovered(p)
          result = await p.auth!.login({ authRealmId: a.authRealmId }, input.method, {
            ...(handle !== undefined ? { secretHandle: handle } : {}),
            onOutput: (text) => { try { onOutput?.(text) } catch { /* display only */ } },
            signal: run.controller.signal,
          })
          // Signed in, also after a "failure" (a cancelled login may have
          // finished anyway): recorded from what the login itself observed,
          // while this lease still holds the account, so nothing launches on
          // it before the record says what its realm now holds (design 5.5).
          if (result.state === 'signed-in') {
            let observed: AuthOperationResult & { state: KnownAuthState } = { ...result, state: 'signed-in' }
            // A login that did not say which kind of sign-in it left is
            // checked again, still under this lease: the comparison must not
            // depend on the login reporting it.
            if (result.credential !== 'account' && result.credential !== 'api-key') {
              const again = await p.auth!.status({ authRealmId: a.authRealmId }).catch(() => null)
              if (again?.ok) observed = again
            }
            // Still unreadable, after a login this call ran: compare the kind
            // of sign-in that login was for, so a change of kind still blocks.
            if (observed.credential !== 'account' && observed.credential !== 'api-key' && result.code !== 'already-signed-in') {
              observed = { ...observed, credential: input.method === 'apiKey' ? 'api-key' : 'account' }
            }
            const check = observed
            observedClass = this.checkInput(check).observedCredential
            recorded = await ctx.store.mutate((d, t) => recordAuthCheck(d, a.id, this.checkInput(check), t))
          }
        }
      }
    } catch {
      result = { ok: false, code: 'not-started' }
    } finally {
      burn()
      if (this.signIns.get(a.id) === run) this.signIns.delete(a.id)
      lease?.release()
      this.changed()
    }
    if (refusal) return refusal
    if (recorded) {
      const bad = this.fromStore(recorded)
      if (bad) {
        // The realm changed but the record could not say so: nothing launches
        // on the account until a later check is recorded.
        this.unrecordedSignIns.set(a.id, observedClass)
        this.changed()
        return bad
      }
      this.unrecordedSignIns.delete(a.id)
      // A different kind of sign-in than the record's: the account is now
      // blocked until the user confirms it in Accounts.
      if (recorded.ok && findAccount(recorded.doc, a.id)?.operationalState === 'blocked') return failure('sign-in-changed', undefined, { state: 'signed-in' })
      return { ok: true, state: 'signed-in' }
    }
    return this.fromAuth(result)
  }

  /** Cancel a sign-in this renderer started; nothing else. */
  cancelSignIn(input: { accountId: string }, senderId: number): AccountsResult {
    const run = this.signIns.get(input.accountId)
    if (!run || run.senderId !== senderId) return failure('not-found')
    run.controller.abort()
    return { ok: true }
  }

  /** Verify the realm is signed in, name it, and make it a selectable account. */
  async completeSetup(input: { accountId: string; identity: SetupIdentityChoice }): Promise<AccountsResult<{ accountId: string }>> {
    const ready = this.ready()
    if ('ok' in ready) return ready
    const j = ready.doc.journals.find((x) => x.accountId === input.accountId)
    if (!j) return failure('not-found')
    const p = this.pkg(j.providerId)
    if (!p?.auth) return failure('unsupported')
    if (!this.isEnabled(p.id)) return failure('provider-disabled')
    if (!this.capability(p, 'auth.status').enabled) return failure('capability-disabled')
    if (this.signIns.has(j.accountId)) return failure('busy')
    const external = findRealm(ready.doc, j.realmId)?.ownership === 'external-default'
    if (external && input.identity.mode === 'link') return failure('not-linkable', 'An unverified external sign-in keeps its own identity.')
    if (input.identity.mode === 'new' && !isIdentityColourKey(input.identity.colourKey)) return failure('invalid-value', 'That colour is not available.')
    // Held for the check and the commit: an abandon or a sign-in cannot run
    // meanwhile, and one already running refuses this.
    const lease = await this.operationLease(ready.store, j.accountId, j.providerId)
    if ('ok' in lease) return lease
    try {
      await this.ensureDiscovered(p)
      const status = await p.auth.status({ authRealmId: j.realmId }).catch((): AuthOperationResult & { state: KnownAuthState } => ({ ok: false, code: 'not-started', state: 'error' }))
      if (!status.ok) return this.fromAuth(status)
      if (status.state !== 'signed-in') return failure('not-signed-in', undefined, { state: status.state })
      const identityId = input.identity.mode === 'link' ? input.identity.identityId : makeOpaqueId('identity', this.deps.randomHex())
      const choice = input.identity
      // The flow this run signed in with, else the one the setup began with
      // (a setup finished after a restart), so the record keeps a kind of
      // credential the next check can compare.
      const began = SIGN_IN_METHODS.includes(j.method as SignInMethod) ? j.method as SignInMethod : undefined
      const authMethod = external ? (status.credential === 'api-key' ? 'apiKey' : status.credential === 'account' ? 'external' : 'unknown') : methodFromCredential(status.credential, this.signedInWith.get(j.accountId) ?? began)
      const committed = await ready.store.mutate((d, t) => chain(d, [
        ...(choice.mode === 'new' ? [(x: ProviderRegistryDoc) => createIdentity(x, { id: identityId, friendlyName: choice.friendlyName, colourKey: choice.colourKey, ...(choice.groupId !== undefined ? { groupId: choice.groupId } : {}) }, t)] : []),
        (x) => commitAccountSetup(x, j.accountId, { identityId, authMethod, lastKnownAuthState: 'signed-in', identityAssurance: external ? 'realm-only' : 'user-asserted' }, t),
      ]))
      const bad = this.fromStore(committed)
      if (bad) return bad
      this.signedInWith.delete(j.accountId)
      this.deps.secrets.discardForAccount(j.accountId)
      return { ok: true, accountId: j.accountId }
    } finally {
      lease.release()
    }
  }

  /** Drop a setup: sign its realm out through the provider, remove its
   *  folder, and only then the journal. Any failure keeps the journal, so
   *  the setup stays visible and nothing is left unmanaged. */
  async abandonSetup(input: { accountId: string }): Promise<AccountsResult> {
    const ready = this.ready()
    if ('ok' in ready) return ready
    const j = ready.doc.journals.find((x) => x.accountId === input.accountId)
    if (!j) return failure('not-found')
    if (this.signIns.has(j.accountId)) return failure('busy')
    const external = findRealm(ready.doc, j.realmId)?.ownership === 'external-default'
    const p = this.pkg(j.providerId)
    const runsCli = !external && !!p?.auth && !!p.realmFolders
    if (runsCli) {
      // Signing the realm out needs the provider's CLI: the setup is kept
      // (visible, retryable) rather than its folder left unchecked.
      if (!this.isEnabled(j.providerId)) return failure('provider-disabled')
      if (!this.capability(p!, 'auth.status').enabled || !this.capability(p!, 'auth.logout').enabled) return failure('capability-disabled')
    }
    const release = await ready.store.exclusive((): (() => void) | AccountsFailure => {
      if (runsCli && !this.isEnabled(j.providerId)) return failure('provider-disabled')
      return this.deps.leases.hold(j.accountId, j.providerId) ?? failure('busy')
    })
    if (typeof release !== 'function') return release
    try {
      if (runsCli && p?.auth && p.realmFolders) {
        await this.ensureDiscovered(p)
        const status = await p.auth.status({ authRealmId: j.realmId }).catch(() => null)
        if (status?.ok && status.state === 'signed-in') {
          const out = await p.auth.logout({ authRealmId: j.realmId }).catch((): AuthOperationResult => ({ ok: false, code: 'not-started' }))
          if (!out.ok) return this.fromAuth(out)
        }
        const removed = await p.realmFolders.remove({ authRealmId: j.realmId }, { contents: 'all' }).catch(() => ({ ok: false as const, code: 'io-failed' as const }))
        if (!removed.ok) return failure((removed.code ?? 'io-failed') as AccountsFailureCode, 'The account folder could not be removed; the setup is kept.')
      }
      const dropped = await ready.store.mutate((d) => abandonAccountSetup(d, j.accountId))
      const bad = this.fromStore(dropped)
      if (bad) return bad
      this.signedInWith.delete(j.accountId)
      this.deps.secrets.discardForAccount(j.accountId)
      return { ok: true }
    } finally {
      release()
    }
  }

  // -------------------------------------------------------------------------
  // Accounts (5.3, 11)
  // -------------------------------------------------------------------------

  private accountContext(accountId: string): { store: AccountRegistryStore; doc: ProviderRegistryDoc; p: ProviderPackage | null; external: boolean; legacy: boolean; realmActive: boolean } | AccountsFailure {
    const ready = this.ready()
    if ('ok' in ready) return ready
    const a = findAccount(ready.doc, accountId)
    if (!a) return failure('not-found')
    const realm = findRealm(ready.doc, a.authRealmId)
    return {
      ...ready, p: this.pkg(a.providerId), external: realm?.ownership === 'external-default', legacy: isLegacyLinked(ready.doc, accountId),
      realmActive: realm?.lifecycle === 'active' && realm.ownerProviderAccountId === accountId,
    }
  }

  /** Whether a provider operation may run on this account at all: the
   *  provider offers it, the account is not archived and its realm is live
   *  (an archived external record names the same home a newer account may
   *  use -- its leases are that account's, not this one's), the provider is
   *  on, and every capability the operation uses is enabled. */
  private runnable(
    ctx: { p: ProviderPackage | null; realmActive: boolean },
    a: { lifecycle: AccountLifecycle; providerId: ProviderId },
    caps: readonly CapabilityKey[],
  ): AccountsFailure | null {
    if (!ctx.p?.auth) return failure('unsupported')
    if (a.lifecycle === 'archived' || !ctx.realmActive) return failure('lifecycle', 'This account is archived; nothing runs on it here.')
    if (!this.isEnabled(a.providerId)) return failure('provider-disabled')
    for (const c of caps) if (!this.capability(ctx.p, c).enabled) return failure('capability-disabled')
    return null
  }

  /** Take an operation lease under the registry lock -- only while the
   *  provider is on and nothing holds the account (nor, for a setup, a
   *  sign-in runs on it) -- or say why not. */
  private async operationLease(store: AccountRegistryStore, accountId: string, providerId: ProviderId): Promise<AccountLease | AccountsFailure> {
    const ownerId = `op-${++this.opSeq}`
    return store.exclusive((): AccountLease | AccountsFailure => {
      if (!this.isEnabled(providerId)) return failure('provider-disabled')
      if (this.signIns.has(accountId)) return failure('busy')
      const r = this.deps.leases.add(accountId, providerId, { kind: 'operation', ownerId })
      return r.ok ? r.lease : failure('busy')
    })
  }

  /** Take the account exclusively under the registry lock, or say why not. */
  private async exclusiveHold(store: AccountRegistryStore, accountId: string, providerId: ProviderId): Promise<(() => void) | AccountsFailure> {
    const r = await store.exclusive(() => {
      // Under the lock a switch-off takes: never both.
      if (!this.isEnabled(providerId)) return failure('provider-disabled')
      const release = this.deps.leases.hold(accountId, providerId)
      return release ?? (this.deps.leases.count(accountId) > 0 ? failure('consumers', undefined, { consumers: this.deps.leases.count(accountId) }) : failure('busy'))
    })
    return r
  }

  /** The provider's status check on one account, recorded. Single-flight
   *  per account: a check asked for while one runs joins it, so a burst of
   *  "Check sign-in" clicks starts one CLI process and holds one lease. */
  refreshStatus(input: { accountId: string }): Promise<AccountsResult<{ state: KnownAuthState }>> {
    const key = String(input?.accountId)
    const running = this.statusChecks.get(key)
    if (running) return running
    const check = this.runStatusCheck(input).finally(() => { this.statusChecks.delete(key) })
    this.statusChecks.set(key, check)
    return check
  }

  private async runStatusCheck(input: { accountId: string }): Promise<AccountsResult<{ state: KnownAuthState }>> {
    const ctx = this.accountContext(input.accountId)
    if ('ok' in ctx) return ctx
    const a = findAccount(ctx.doc, input.accountId)!
    const refused = this.runnable(ctx, a, ['auth.status'])
    if (refused) return refused
    const lease = await this.operationLease(ctx.store, a.id, a.providerId)
    if ('ok' in lease) return lease
    let status: AuthOperationResult & { state: KnownAuthState }
    try {
      await this.ensureDiscovered(ctx.p!)
      status = await ctx.p!.auth!.status({ authRealmId: a.authRealmId }).catch(() => ({ ok: false, code: 'not-started' as const, state: 'error' as const }))
    } finally {
      lease.release()
    }
    // A check that could not run is not evidence about the account.
    if (!status.ok) return this.fromAuth(status)
    // After a sign-in the record could not take, a status that names no kind
    // is compared with the kind that sign-in left, not taken as clean.
    const checked = this.checkInput(status)
    const remembered = this.unrecordedSignIns.get(a.id)
    if (status.state === 'signed-in' && checked.observedCredential === undefined && remembered !== undefined) checked.observedCredential = remembered
    const recorded = await ctx.store.mutate((d, t) => recordAuthCheck(d, a.id, checked, t))
    const bad = this.fromStore(recorded)
    if (bad) return bad
    if (this.unrecordedSignIns.delete(a.id)) this.changed()
    return { ok: true, state: status.state }
  }

  /** "This is still my account": the explicit reconcile after a blocked
   *  check (design 5.3, 5.5), and the only way to clear `blocked`. Checks
   *  the realm now and makes the record say what it holds; the user's
   *  request is the vouching. A check that cannot run changes nothing. */
  async reconcileSignIn(input: { accountId: string }): Promise<AccountsResult<{ state: KnownAuthState }>> {
    const ctx = this.accountContext(input.accountId)
    if ('ok' in ctx) return ctx
    const a = findAccount(ctx.doc, input.accountId)!
    const refused = this.runnable(ctx, a, ['auth.status'])
    if (refused) return refused
    const lease = await this.operationLease(ctx.store, a.id, a.providerId)
    if ('ok' in lease) return lease
    let status: AuthOperationResult & { state: KnownAuthState }
    try {
      await this.ensureDiscovered(ctx.p!)
      status = await ctx.p!.auth!.status({ authRealmId: a.authRealmId }).catch(() => ({ ok: false, code: 'not-started' as const, state: 'error' as const }))
    } finally {
      lease.release()
    }
    if (!status.ok) return this.fromAuth(status)
    const r = await ctx.store.mutate((d, t) => reconcileAccountSignIn(d, a.id, this.checkInput(status), t))
    const bad = this.fromStore(r)
    if (bad) return bad
    if (this.unrecordedSignIns.delete(a.id)) this.changed()
    return { ok: true, state: status.state }
  }

  /** What a status reported, as the registry records and compares it. */
  private checkInput(status: AuthOperationResult & { state: KnownAuthState }): { state: KnownAuthState; observedCredential?: CredentialClass } {
    const c = status.state === 'signed-in' ? observedCredential(status.credential) : undefined
    return { state: status.state, ...(c ? { observedCredential: c } : {}) }
  }

  /** Design 5.5: before an operation that acts on an external home, check
   *  that it still holds the sign-in the record says. The check is recorded;
   *  a different sign-in (or one already blocked) refuses the operation
   *  until the user reconciles it. A check that cannot run proves nothing
   *  either way and is reported as such. Runs under the caller's hold. */
  private async externalStillMatches(
    store: AccountRegistryStore, p: ProviderPackage, accountId: string, realmId: string,
    opts: { unansweredBlocks: boolean },
  ): Promise<AccountsFailure | null> {
    // Blocked is sticky: an account already blocked stays refused, answer or not.
    const blocked = () => (store.current() && findAccount(store.current()!, accountId)?.operationalState === 'blocked' ? failure('sign-in-changed') : null)
    if (!this.isEnabled(p.id)) return opts.unansweredBlocks ? failure('provider-disabled') : blocked()
    if (!this.capability(p, 'auth.status').enabled) return opts.unansweredBlocks ? failure('capability-disabled') : blocked()
    await this.ensureDiscovered(p)
    const status = await p.auth!.status({ authRealmId: realmId }).catch((): AuthOperationResult & { state: KnownAuthState } => ({ ok: false, code: 'not-started', state: 'error' }))
    if (!status.ok) return opts.unansweredBlocks ? this.fromAuth(status) : blocked()
    const recorded = await store.mutate((d, t) => recordAuthCheck(d, accountId, this.checkInput(status), t))
    if (!recorded.ok) return this.fromStore(recorded)
    const now = findAccount(recorded.doc, accountId)
    return now?.operationalState === 'blocked' ? failure('sign-in-changed', undefined, { state: status.state }) : null
  }

  /** Sign an account's realm out. Blocked while anything uses the account;
   *  an external home needs the user's acknowledgement of its wider effect. */
  async logout(input: { accountId: string; acknowledgeExternal?: boolean }): Promise<AccountsResult<{ state: KnownAuthState }>> {
    const ctx = this.accountContext(input.accountId)
    if ('ok' in ctx) return ctx
    const a = findAccount(ctx.doc, input.accountId)!
    const refused = this.runnable(ctx, a, ctx.external ? ['auth.logout', 'auth.status'] : ['auth.logout'])
    if (refused) return refused
    if (ctx.external && input.acknowledgeExternal !== true) return failure('acknowledgement-required')
    const p = ctx.p!
    const release = await this.exclusiveHold(ctx.store, a.id, a.providerId)
    if (typeof release !== 'function') return release
    try {
      if (ctx.external) {
        // The sign-out itself needs the CLI, so a check that cannot run blocks it.
        const changed = await this.externalStillMatches(ctx.store, p, a.id, a.authRealmId, { unansweredBlocks: true })
        if (changed) return changed
      }
      await this.ensureDiscovered(p)
      const out = await p.auth!.logout({ authRealmId: a.authRealmId }, ctx.external ? { acknowledgeExternalRealm: true } : {})
        .catch((): AuthOperationResult => ({ ok: false, code: 'not-started' }))
      if (out.state === 'signed-out' || out.state === 'signed-in') {
        const state = out.state
        const recorded = await ctx.store.mutate((d, t) => recordAuthCheck(d, a.id, { state }, t))
        if (!recorded.ok) this.log(`a sign-out result was not saved (${recorded.code})`)
      }
      if (!out.ok) return this.fromAuth(out)
      return { ok: true, state: 'signed-out' }
    } finally {
      release()
    }
  }

  async setLifecycle(input: { accountId: string; lifecycle: AccountLifecycle; acknowledgeExternal?: boolean }): Promise<AccountsResult> {
    const ctx = this.accountContext(input.accountId)
    if ('ok' in ctx) return ctx
    const a = findAccount(ctx.doc, input.accountId)!
    const next = input.lifecycle
    const apply = async (): Promise<AccountsResult> => {
      let consumers = 0
      let held = false
      const r = await ctx.store.mutate((d, t) => {
        // Under the lock that applies it: a sign-out, archive or abandon
        // holding the account is never overtaken by a lifecycle change.
        if (this.deps.leases.isHeld(a.id)) { held = true; return { ok: false, code: 'blocked-by-consumers', message: 'held' } }
        consumers = this.deps.leases.count(a.id)
        return setAccountLifecycle(d, a.id, next, { consumers }, t)
      })
      if (held) return failure('busy')
      const bad = this.fromStore(r, consumers)
      if (bad) return bad
      // A mirrored account's lifecycle is the provider's own list's too:
      // write it there now, not at the next start.
      if (ctx.legacy) await this.writeThroughProviders([a.providerId])
      return { ok: true }
    }
    if (next === 'inactive') return apply()
    if (next === 'active') {
      // Re-activation checks the sign-in first (11): a signed-out account
      // comes back needing attention, never as ready -- so a check that
      // cannot run (capability off, provider off) refuses it.
      if (ctx.p?.auth && !ctx.legacy && a.lifecycle === 'inactive') {
        const checked = await this.refreshStatus({ accountId: a.id })
        if (!checked.ok) return checked
      }
      return apply()
    }
    if (next === 'archived') {
      if (ctx.legacy) return apply() // the registry refuses: removed where it was created
      if (ctx.external) {
        // Credentials stay under the other client's control: say so first.
        if (input.acknowledgeExternal !== true) return failure('acknowledgement-required', 'Archiving only forgets this sign-in here; it stays signed in for other apps. Confirm to continue.')
        if (!ctx.p?.auth || a.lifecycle !== 'inactive') return apply() // the registry names the rule
        const release = await this.exclusiveHold(ctx.store, a.id, a.providerId)
        if (typeof release !== 'function') return release
        try {
          // Design 5.5: a home that now holds another sign-in is reconciled
          // first. Archiving changes nothing outside this app, so a check
          // that cannot run (the CLI gone) does not keep the record.
          const changed = await this.externalStillMatches(ctx.store, ctx.p, a.id, a.authRealmId, { unansweredBlocks: false })
          if (changed) return changed
          // Held: the count is 0 and nothing new could start.
          const r = await ctx.store.mutate((d, t) => setAccountLifecycle(d, a.id, 'archived', { consumers: this.deps.leases.count(a.id) }, t))
          return this.fromStore(r) ?? { ok: true }
        } finally {
          release()
        }
      }
      if (!ctx.p?.auth) return apply()
      // A managed archive leaves a credential-free tombstone: sign out first,
      // and a failed sign-out fails the archive (the account stays inactive).
      if (a.lifecycle !== 'inactive') return apply() // the registry names the rule
      const refused = this.runnable(ctx, a, ['auth.status', 'auth.logout'])
      if (refused) return refused
      const release = await this.exclusiveHold(ctx.store, a.id, a.providerId)
      if (typeof release !== 'function') return release
      try {
        await this.ensureDiscovered(ctx.p)
        const status = await ctx.p.auth.status({ authRealmId: a.authRealmId }).catch((): AuthOperationResult & { state: KnownAuthState } => ({ ok: false, code: 'not-started', state: 'error' }))
        if (!status.ok) return this.fromAuth(status)
        if (status.state !== 'signed-out') {
          const out = await ctx.p.auth.logout({ authRealmId: a.authRealmId }).catch((): AuthOperationResult => ({ ok: false, code: 'not-started' }))
          if (!out.ok) return this.fromAuth(out)
        }
        const signedOut = await ctx.store.mutate((d, t) => recordAuthCheck(d, a.id, { state: 'signed-out' }, t))
        if (!signedOut.ok) return this.fromStore(signedOut)!
        // Held: the count is 0 and nothing new could start.
        const r = await ctx.store.mutate((d, t) => setAccountLifecycle(d, a.id, 'archived', { consumers: this.deps.leases.count(a.id) }, t))
        return this.fromStore(r) ?? { ok: true }
      } finally {
        release()
      }
    }
    return failure('invalid-request')
  }

  async setDefault(input: { accountId: string }): Promise<AccountsResult> {
    const ready = this.ready()
    if ('ok' in ready) return ready
    const r = await ready.store.mutate((d, t) => setProviderDefault(d, input.accountId, t))
    return this.fromStore(r) ?? { ok: true }
  }

  /** Which account a provider's reviewer invocations use when a request
   *  names none; null goes back to the provider default. */
  async setReviewerDefault(input: SetReviewerDefaultRequest): Promise<AccountsResult> {
    const p = this.pkg(input.providerId)
    if (!p) return failure('not-found')
    const ready = this.ready()
    if ('ok' in ready) return ready
    // An account this platform never lets review is refused with the reason,
    // not stored to be refused at every review (prepare still refuses too).
    const chosen = input.accountId ? findAccount(ready.doc, input.accountId) : undefined
    if (chosen && chosen.providerId === input.providerId) {
      const refusal = this.reviewRefusalOf(ready.doc, chosen)
      if (refusal) return failure('review-unavailable', refusal.message)
    }
    const r = await ready.store.mutate((d, t) => setReviewerDefault(d, input.providerId, input.accountId, t))
    const bad = this.fromStore(r)
    if (bad) return bad
    if (this.reviewerNotices.delete(input.providerId)) this.changed()
    return { ok: true }
  }

  /** Why this account cannot host its provider's reviewer invocations here
   *  (the package's platform rule), as the surface shows it, or undefined.
   *  A rule that could not tell refuses (`unknown`): nothing is offered on a
   *  guess. On macOS the Claude rule reads profiles.json, so a caller that
   *  asks for many accounts passes one `memo` for the call. */
  private reviewRefusalOf(doc: ProviderRegistryDoc, account: { providerId: ProviderId; authRealmId: string }, memo?: Map<string, PlatformReviewRule>): ReviewRefusalView | undefined {
    const r = this.platformReviewRule(doc, account, memo)
    if (r.kind === 'refused') return { reason: 'platform', message: r.message }
    if (r.kind === 'unknown') return { reason: 'unknown', message: 'This app could not check whether this account can run reviews here.' }
    return undefined
  }

  /** The package's platform rule, telling "refused" apart from "could not
   *  tell" (the rule threw): only a definite refusal clears a choice. */
  private platformReviewRule(doc: ProviderRegistryDoc, account: { providerId: ProviderId; authRealmId: string }, memo?: Map<string, PlatformReviewRule>): PlatformReviewRule {
    const p = this.pkg(account.providerId)
    if (!p?.launch?.reviewRefusal || !launchKindsOf(p).includes('review')) return { kind: 'allowed' }
    const realm = findRealm(doc, account.authRealmId)
    if (!realm) return { kind: 'allowed' }
    const known = memo?.get(realm.id)
    if (known) return known
    let rule: PlatformReviewRule
    try {
      const message = p.launch.reviewRefusal(realm)
      rule = typeof message === 'string' && message ? { kind: 'refused', message } : { kind: 'allowed' }
    } catch {
      rule = { kind: 'unknown' }
    }
    memo?.set(realm.id, rule)
    return rule
  }

  /** A reviewer default this platform can never use (chosen before the rule
   *  applied, or the account stopped qualifying) is cleared, never silently
   *  swapped for another: reviews then use the provider default, and the
   *  Accounts surface says what happened. Run at start-up, so a rule that
   *  only becomes definite later leaves the choice in place for that run
   *  (the tool is still not offered on it; the surface shows the refusal). */
  async clearUnusableReviewerDefaults(): Promise<void> {
    const ready = this.ready()
    if ('ok' in ready) return
    for (const a of ready.doc.accounts) {
      if (a.isReviewerDefault !== true) continue
      if (this.platformReviewRule(ready.doc, a).kind !== 'refused') continue
      // Decided again under the lock, on the document the write applies to:
      // a choice the user made meanwhile is theirs, and only a definite
      // refusal clears (a rule that could not tell, e.g. the profile list
      // unreadable at start-up, clears nothing).
      let cleared: string | null = null
      const r = await ready.store.mutate((d, t) => {
        const cur = findAccount(d, a.id)
        if (cur?.isReviewerDefault !== true) return { ok: true, doc: d }
        const rule = this.platformReviewRule(d, cur)
        if (rule.kind !== 'refused') return { ok: true, doc: d }
        const out = setReviewerDefault(d, a.providerId, null, t)
        if (out.ok) cleared = rule.message
        return out
      })
      if (!r.ok) { this.log(`an unusable ${a.providerId} reviewer default was not cleared (${r.code})`); continue }
      if (cleared === null) continue
      this.reviewerNotices.set(a.providerId, { message: cleared, store: ready.store })
      this.changed()
    }
  }

  /** Whether a review of this provider could run now, and on which account:
   *  the answer reviewReady gives, for the surface. */
  private reviewReadiness(p: ProviderPackage, doc: ProviderRegistryDoc | null, memo: Map<string, PlatformReviewRule>): ReviewReadinessView | undefined {
    if (!p.review || !p.launch || !launchKindsOf(p).includes('review')) return undefined
    const chosen = doc ? chooseReviewerAccount(doc, p.id) : null
    const choice = chosen?.ok && chosen.source !== 'explicit' ? { accountId: chosen.accountId, source: chosen.source } : {}
    return { ready: this.reviewReady(p.id, memo), ...choice }
  }

  // -------------------------------------------------------------------------
  // Identities and groups (5.1, 5.2)
  // -------------------------------------------------------------------------

  /** Legacy stores whose accounts use this identity: they mirror its name
   *  and colour, so they get the edit now. */
  private async writeThrough(doc: ProviderRegistryDoc, identityIds: readonly string[]): Promise<void> {
    const providers = new Set<ProviderId>()
    for (const a of doc.accounts) if (identityIds.includes(a.identityId) && isLegacyLinked(doc, a.id)) providers.add(a.providerId)
    await this.writeThroughProviders([...providers])
  }

  private async writeThroughProviders(providers: readonly ProviderId[]): Promise<void> {
    if (!this.deps.reconcileLegacy) return
    for (const id of providers) {
      try { await this.deps.reconcileLegacy(id) } catch (e) { this.log(`legacy write-through for ${id} failed; it is retried at the next start (${e instanceof Error ? e.message : String(e)})`) }
    }
  }

  async updateIdentity(input: { identityId: string } & IdentityPatch): Promise<AccountsResult> {
    const ready = this.ready()
    if ('ok' in ready) return ready
    // The registry's own transition reads only the patch fields it knows.
    const { identityId: _id, ...patch } = input
    const r = await ready.store.mutate((d, t) => updateIdentity(d, input.identityId, patch, t))
    const bad = this.fromStore(r)
    if (bad) return bad
    if (r.ok) await this.writeThrough(r.doc, [input.identityId])
    return { ok: true }
  }

  /** Settle a name or colour edited in both places (design 6.2): keep this
   *  app's value (written through to the provider's own list now) or the
   *  provider's (already there). */
  async resolveIdentityConflict(input: ResolveConflictRequest): Promise<AccountsResult> {
    const ready = this.ready()
    if ('ok' in ready) return ready
    const { keep, ...ref } = input
    const r = await ready.store.mutate((d, t) => resolveIdentityConflict(d, ref, keep, t))
    const bad = this.fromStore(r)
    if (bad) return bad
    if (r.ok) await this.writeThrough(r.doc, [input.identityId])
    return { ok: true }
  }

  async createGroup(input: { name: string }): Promise<AccountsResult<{ groupId: string }>> {
    const ready = this.ready()
    if ('ok' in ready) return ready
    const groupId = makeOpaqueId('group', this.deps.randomHex())
    const r = await ready.store.mutate((d, t) => createGroup(d, { id: groupId, name: input.name }, t))
    return this.fromStore(r) ?? { ok: true, groupId }
  }

  async renameGroup(input: { groupId: string; name: string }): Promise<AccountsResult> {
    const ready = this.ready()
    if ('ok' in ready) return ready
    const r = await ready.store.mutate((d, t) => renameGroup(d, input.groupId, input.name, t))
    return this.fromStore(r) ?? { ok: true }
  }

  async deleteGroup(input: { groupId: string }): Promise<AccountsResult> {
    const ready = this.ready()
    if ('ok' in ready) return ready
    const r = await ready.store.mutate((d, t) => deleteGroup(d, input.groupId, t))
    return this.fromStore(r) ?? { ok: true }
  }

  async linkIdentity(input: { accountId: string; identityId: string }): Promise<AccountsResult> {
    const ready = this.ready()
    if ('ok' in ready) return ready
    const r = await ready.store.mutate((d, t) => linkAccountIdentity(d, input.accountId, input.identityId, t))
    const bad = this.fromStore(r)
    if (bad) return bad
    if (r.ok) await this.writeThrough(r.doc, [input.identityId])
    return { ok: true }
  }

  async unlinkIdentity(input: { accountId: string }): Promise<AccountsResult<{ identityId: string }>> {
    const ready = this.ready()
    if ('ok' in ready) return ready
    const identityId = makeOpaqueId('identity', this.deps.randomHex())
    const r = await ready.store.mutate((d, t) => unlinkAccountIdentity(d, input.accountId, identityId, t))
    const bad = this.fromStore(r)
    if (bad) return bad
    if (r.ok) await this.writeThrough(r.doc, [identityId])
    return { ok: true, identityId }
  }

  // -------------------------------------------------------------------------
  // The provider's own default sign-in (6.3, 9.3)
  // -------------------------------------------------------------------------

  /** The one-time start-up adoption, run again after the user answers. */
  async migrateExternalDefault(providerId: ProviderId): Promise<AccountsResult<{ outcome: ExternalDefaultMigrationOutcome }>> {
    const p = this.pkg(providerId)
    if (!p?.externalDefaultRealm) return failure('unsupported')
    // Nothing is recorded: the start-up run tries again once it can check.
    if (!this.capability(p, 'auth.status').enabled) return failure('capability-disabled')
    const store = this.currentStore()
    if (!store) return failure('registry-unavailable')
    // Its discovery is this service's one run per provider, never a second
    // one overlapping another caller's.
    const outcome = await migrateExternalDefaultRealm(p, {
      store, preference: (id) => this.preferenceOf(id), log: (m) => this.log(m), discover: () => this.discoverOnce(p),
    })
    this.migrationRuns.set(providerId, outcome)
    this.changed()
    return { ok: true, outcome }
  }

  /** The explicit "use my existing sign-in" (and "check again"): status in
   *  the provider's own default home, and a realm-only account when it is
   *  signed in. Unverified until the user re-authenticates into a managed
   *  account; never linked. */
  async adoptExternalDefault(input: { providerId: ProviderId }): Promise<AccountsResult<{ accountId: string }>> {
    const p = this.pkg(input.providerId)
    const spec = p?.externalDefaultRealm
    if (!p || !spec || !p.auth || !p.setup) return failure('unsupported')
    if (!this.isEnabled(p.id)) return failure('provider-disabled')
    if (!this.capability(p, 'auth.status').enabled) return failure('capability-disabled')
    const ready = this.ready()
    if ('ok' in ready) return ready
    const accountId = makeOpaqueId('account', this.deps.randomHex())
    const realmId = makeOpaqueId('realm', this.deps.randomHex())
    const identityId = makeOpaqueId('identity', this.deps.randomHex())
    const begun = await ready.store.mutate((d, t) => beginAccountSetup(d, {
      accountId, realmId, providerId: p.id, method: 'external', realmKind: spec.kind, ownership: 'external-default', pathRef: EXTERNAL_DEFAULT_PATH_REF,
    }, t))
    const bad = this.fromStore(begun)
    if (bad) return bad.code === 'realm-conflict' ? failure('realm-conflict', 'That sign-in is already registered, or being set up; try again when that finishes.') : bad
    const drop = async () => {
      const r = await ready.store.mutate((d) => abandonAccountSetup(d, accountId))
      if (!r.ok) this.log(`an adoption's reservation was not dropped (${r.code}); it shows as a pending setup`)
    }
    // Held where a provider switch-off sees it, and refused once it is off.
    const leased = await ready.store.exclusive(() => (this.isEnabled(p.id) ? this.deps.leases.add(accountId, p.id, { kind: 'operation', ownerId: `op-${++this.opSeq}` }) : null))
    if (!leased?.ok) { await drop(); return failure(leased ? 'busy' : 'provider-disabled') }
    let status: AuthOperationResult & { state: KnownAuthState }
    try {
      await this.discover(p.id)
      status = await p.auth.status({ authRealmId: realmId })
    } catch {
      status = { ok: false, code: 'not-started', state: 'error' }
    } finally {
      leased.lease.release()
    }
    if (!status.ok) { await drop(); return this.fromAuth(status) }
    if (status.state !== 'signed-in') { await drop(); return failure('not-signed-in', 'Your existing sign-in is signed out; sign in to add an account.', { state: status.state }) }
    const authMethod: AuthMethod = status.credential === 'api-key' ? 'apiKey' : status.credential === 'account' ? 'external' : 'unknown'
    const committed = await ready.store.mutate((d, t) => chain(d, [
      (x) => createIdentity(x, { id: identityId, friendlyName: spec.identityLabel, colourKey: EXTERNAL_IDENTITY_COLOUR }, t),
      (x) => commitAccountSetup(x, accountId, { identityId, authMethod, lastKnownAuthState: 'signed-in', identityAssurance: 'realm-only' }, t),
      // Settles the one-time run too, when it never answered (append-only).
      (x) => recordProviderMigration(x, { providerId: p.id, step: 'external-default', outcome: 'registered' }, t),
    ]))
    const notSaved = this.fromStore(committed)
    if (notSaved) { await drop(); return notSaved }
    return { ok: true, accountId }
  }

  // -------------------------------------------------------------------------
  // Launch leases (sessions: commit 4; reviewer invocations: commit 5) and
  // renderer lifetime
  // -------------------------------------------------------------------------

  /** Bind a launch to its account and hold the account while it runs. ONE
   *  path for both kinds of launch: an interactive session names its
   *  account; a reviewer invocation may name one, else gets the provider's
   *  reviewer default, else its default account. Either way the choice, the
   *  binding (resolved from the account id alone) and the lease are made
   *  under the registry lock, so no lifecycle change can slip between them
   *  (A11, WP1.42). */
  async acquireLaunchLease(input: {
    kind: LaunchLeaseKind
    providerId: ProviderId
    /** Required for a session; optional for a reviewer invocation. */
    providerAccountId?: string
    /** The session id or review id: one lease per owner. */
    ownerId: string
    acknowledgeRealmOnly?: boolean
  }): Promise<LaunchLeaseResult> {
    if (!LAUNCH_LEASE_KINDS.includes(input.kind)) return failure('invalid-request')
    if (input.kind === 'session' && input.providerAccountId === undefined) return failure('invalid-request', 'A session must name its account.')
    const store = this.currentStore()
    if (!store) return failure('registry-unavailable')
    return store.exclusive((): LaunchLeaseResult => {
      const doc = store.current()
      if (!doc || store.status().mode !== 'ready') return failure('registry-unavailable')
      let accountId = input.providerAccountId
      let reviewer: ReviewerChoice | undefined
      if (input.kind === 'review') {
        const chosen = chooseReviewerAccount(doc, input.providerId, input.providerAccountId)
        if (!chosen.ok) return failure('not-found', chosen.message)
        accountId = chosen.accountId
        reviewer = chosen.source
      }
      const b = resolveLaunchBinding(doc, { providerId: input.providerId, providerAccountId: accountId! })
      if (!b.ok) return failure(b.code === 'realm-unavailable' ? 'realm-unavailable' : b.code === 'not-active' ? 'lifecycle' : b.code === 'blocked' ? 'lifecycle' : b.code === 'provider-mismatch' ? 'invalid-request' : b.code, b.message)
      if (!this.isEnabled(input.providerId)) return failure('provider-disabled')
      if (b.realmOnly && input.acknowledgeRealmOnly !== true) return failure('acknowledgement-required', 'This sign-in is unverified: confirm that this launch may use it.')
      // Nothing launches on an account whose sign-in is being replaced (a
      // "sign in again" in flight): its realm changes underneath the launch.
      if (this.signIns.has(b.binding.providerAccountId) || this.deps.leases.countKind(b.binding.providerAccountId, 'sign-in') > 0) {
        return failure('busy', 'This account is signing in again; try again when that finishes.')
      }
      if (this.unrecordedSignIns.has(b.binding.providerAccountId)) {
        return failure('sign-in-changed', 'This account signed in again, but the app could not record it. Check it in Accounts before using it.')
      }
      const added = this.deps.leases.add(b.binding.providerAccountId, input.providerId, { kind: input.kind, ownerId: input.ownerId })
      if (!added.ok) return added.code === 'held' ? failure('busy') : failure('invalid-request', 'That launch is already bound to another account.')
      return { ok: true, lease: added.lease, binding: b.binding, realmOnly: b.realmOnly, ...(reviewer ? { reviewer } : {}) }
    })
  }

  /** Why a session of this provider cannot run on another machine (an SSH
   *  session), or null when it can: its `session.ssh` capability, never its
   *  name. Asked before anything else is done for such a spawn. */
  remoteLaunchRefusal(providerId: ProviderId): AccountsFailure | null {
    const p = this.pkg(providerId)
    if (!p) return failure('unsupported')
    if (this.capability(p, 'session.ssh').enabled) return null
    return failure('unsupported', `${p.displayName} runs on this computer only in this release; it is not available in SSH sessions.`)
  }

  /** Whether a reviewer invocation of this provider can be prepared now: a
   *  review tool is offered only then (commit 5b, decision 3). The package
   *  reviews and prepares reviews here, the provider is on, and the account a
   *  review would use (the reviewer default, else the provider default) is
   *  active, not blocked, locatable, and needs no per-launch acknowledgement,
   *  which an agent cannot give. The same checks prepareLaunch makes before
   *  it runs anything; the executable and the lease are checked when a
   *  review starts. Synchronous, and asked per MCP connection: no CLI, and
   *  no I/O beyond the platform rule (on macOS the Claude rule reads
   *  profiles.json). */
  reviewReady(providerId: ProviderId, memo?: Map<string, PlatformReviewRule>): boolean {
    const p = this.pkg(providerId)
    if (!p?.launch || !p.review || !launchKindsOf(p).includes('review')) return false
    if (!this.capability(p, 'session.launch').enabled || !this.isEnabled(p.id)) return false
    const ready = this.ready()
    if ('ok' in ready) return false
    const chosen = chooseReviewerAccount(ready.doc, p.id)
    if (!chosen.ok) return false
    const a = findAccount(ready.doc, chosen.accountId)
    if (!a || a.identityAssurance === 'realm-only' || findRealm(ready.doc, a.authRealmId)?.ownership === 'external-default') return false
    // Never offered on an account this platform will not let review.
    if (this.reviewRefusalOf(ready.doc, a, memo)) return false
    // Nor while its sign-in is being replaced or could not be recorded:
    // prepareLaunch refuses both (acquireLaunchLease).
    if (this.signIns.has(a.id) || this.deps.leases.countKind(a.id, 'sign-in') > 0 || this.unrecordedSignIns.has(a.id)) return false
    return resolveLaunchBinding(ready.doc, { providerId: p.id, providerAccountId: a.id }).ok
  }

  /** The transcript folders of a provider's live realms (plan A13): what the
   *  usage index reads beside the provider's own default folder. Paths only;
   *  a realm that cannot be located now is left out. */
  async sessionsDirs(providerId: ProviderId): Promise<string[]> {
    const p = this.pkg(providerId)
    const ready = this.ready()
    // Only a package whose sessions launch here writes session transcripts in
    // its realms (a reviewer invocation persists none).
    if (!p?.launch || !launchKindsOf(p).includes('session') || 'ok' in ready) return []
    const out: string[] = []
    for (const realm of ready.doc.realms) {
      if (realm.providerId !== p.id || realm.lifecycle !== 'active') continue
      let dir: string | null = null
      try { dir = await p.launch.sessionsDir({ authRealmId: realm.id }) } catch { dir = null }
      if (typeof dir === 'string' && dir && !out.includes(dir)) out.push(dir)
    }
    return out
  }

  /** Prepare a launch in its account's realm (plan A10; design 5.5, 5.7, 11),
   *  one path for sessions and reviewer invocations:
   *  1. the provider must launch in realms here, locally unless it supports
   *     remote sessions, and be on;
   *  2. the account: the one named, else (a session) the provider default or
   *     (a review) the reviewer default, then the provider default;
   *  3. an unverified sign-in needs this launch's acknowledgement, before
   *     anything runs;
   *  4. an external home is checked first: a sign-in that changed blocks it;
   *  5. the lease, under the registry lock, on exactly that account;
   *  6. the provider's preparation (the realm's home and the executable setup
   *     proved, re-verified now), and the environment through the package's
   *     own policy. Any refusal after the lease releases it. */
  async prepareLaunch(input: {
    kind: LaunchLeaseKind
    providerId: ProviderId
    providerAccountId?: string
    ownerId: string
    acknowledgeRealmOnly?: boolean
    /** The launch would run on another machine (an SSH session). */
    remote?: boolean
  }): Promise<PreparedLaunchResult> {
    if (!LAUNCH_LEASE_KINDS.includes(input.kind)) return failure('invalid-request')
    const p = this.pkg(input.providerId)
    if (!p?.launch) return failure('unsupported')
    // The package says which kinds it prepares (data, not a provider name): a
    // Claude session keeps its own launch path (A12), so only its reviews come
    // here. Refused before an account is chosen or leased.
    if (!launchKindsOf(p).includes(input.kind)) return failure('unsupported', `${p.displayName} does not start a ${input.kind === 'session' ? 'session' : 'review'} this way.`)
    // A reviewer invocation always runs on this computer, beside the session
    // it serves.
    if (input.kind === 'review' && input.remote === true) return failure('unsupported', 'A review runs on this computer only.')
    if (input.remote === true) {
      const remote = this.remoteLaunchRefusal(p.id)
      if (remote) return remote
    }
    if (!this.capability(p, 'session.launch').enabled) return failure('capability-disabled')
    if (!this.isEnabled(p.id)) return failure('provider-disabled')
    const ready = this.ready()
    if ('ok' in ready) return ready
    const chosen = input.kind === 'review' ? chooseReviewerAccount(ready.doc, p.id, input.providerAccountId) : chooseSessionAccount(ready.doc, p.id, input.providerAccountId)
    if (!chosen.ok) return failure('not-found', chosen.message)
    const a = findAccount(ready.doc, chosen.accountId)
    const realm = a ? findRealm(ready.doc, a.authRealmId) : undefined
    const external = realm?.ownership === 'external-default'
    // The acknowledgement is for the account the request NAMES: one sent with
    // no account acknowledges nothing, so a flag kept from an earlier launch
    // can never consent to whatever the default has since become.
    const acknowledged = input.acknowledgeRealmOnly === true && input.providerAccountId !== undefined && input.providerAccountId === chosen.accountId
    if (a && (a.identityAssurance === 'realm-only' || external) && !acknowledged) {
      return failure('acknowledgement-required', 'This sign-in is unverified: confirm that this launch may use it.')
    }
    // Design 5.5: before every launch on an external home, check it still
    // holds the sign-in on record. (A blocked or inactive account is refused
    // by the binding below without running anything.)
    if (a && external && a.lifecycle === 'active' && a.operationalState !== 'blocked' && a.providerId === p.id) {
      const changed = await this.externalStillMatches(ready.store, p, a.id, a.authRealmId, { unansweredBlocks: true })
      if (changed) return changed
    }
    // The executable the launch runs is the one discovery proved: the first
    // launch after a start proves it here rather than refusing.
    await this.ensureDiscovered(p)
    const leased = await this.acquireLaunchLease({
      kind: input.kind, providerId: p.id, providerAccountId: chosen.accountId, ownerId: input.ownerId,
      ...(acknowledged ? { acknowledgeRealmOnly: true } : {}),
    })
    if (!leased.ok) return leased
    const release = (r: AccountsFailure): AccountsFailure => { leased.lease.release(); return r }
    let prep: Awaited<ReturnType<NonNullable<ProviderPackage['launch']>['prepare']>>
    try { prep = await p.launch.prepare({ authRealmId: leased.binding.authRealmId }) } catch { prep = { ok: false, code: 'not-started' } }
    if (!prep || prep.ok !== true) return release(this.fromAuth(prep && prep.ok === false ? prep : { ok: false, code: 'not-started' }))
    const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0
    if (!text(prep.home) || !text(prep.executable) || !text(prep.sessionsDir) || !prep.baseEnv || typeof prep.baseEnv !== 'object' || !prep.realmEnv || typeof prep.realmEnv !== 'object') {
      return release(failure('internal', 'The launch could not be prepared.'))
    }
    let env: Record<string, string>
    try {
      // The one place a realm patch is applied, with the registered package's
      // own policy: its ambient authority variables out, the selector last.
      env = realmEnvForProvider(p.id, prep.baseEnv, prep.realmEnv)
    } catch {
      return release(failure('internal', 'The launch environment could not be prepared.'))
    }
    return {
      ok: true, lease: leased.lease, binding: leased.binding, realmOnly: leased.realmOnly,
      ...(input.kind === 'review' ? { reviewer: chosen.source } : {}),
      home: prep.home, executable: prep.executable, env, sessionsDir: prep.sessionsDir,
    }
  }

  /** The launch ended: release its lease. Idempotent. */
  releaseLaunch(kind: LaunchLeaseKind, ownerId: string): boolean {
    if (!LAUNCH_LEASE_KINDS.includes(kind)) return false
    return this.deps.leases.releaseOwner(kind, ownerId)
  }

  /** A renderer went away: stop what it started, release what it held. */
  releaseRenderer(senderId: number): void {
    for (const run of this.signIns.values()) if (run.senderId === senderId) run.controller.abort()
    // A run that is still stopping holds its account until its process has
    // actually ended: its own finally releases that lease.
    this.deps.leases.releaseForRenderer(senderId, (lease) => lease.kind === 'sign-in' && this.signIns.get(lease.ownerId)?.senderId === senderId)
    this.deps.secrets.discardForRenderer(senderId)
  }

  /** For a message that names the blocker (design 10, 11). */
  consumersOf(accountId: string) {
    return this.deps.leases.describe(accountId)
  }

  /** Kept for tests and diagnostics: which identity an account shows. */
  identityOf(accountId: string): string | null {
    const doc = this.currentStore()?.current()
    const a = doc ? findAccount(doc, accountId) : undefined
    return a && doc && findIdentity(doc, a.identityId) ? a.identityId : null
  }
}
