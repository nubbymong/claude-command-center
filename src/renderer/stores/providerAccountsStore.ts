// WP2 commit 6: the renderer's copy of the provider-neutral Accounts snapshot
// (design 5.6, 12). Hydrated once at start-up by App and kept current by ONE
// process-lifetime `onChanged` subscription: every push is a full snapshot,
// so a surface never reads a stale account list because it happened to be
// unmounted when a change landed (the cloud-agent listener lesson).
//
// What this store never holds: an API key. The key goes from the Add account
// dialog straight to the preload's one-way `sendSecret` and is never passed
// through here, kept in state or logged.
import { create } from 'zustand'
import type {
  AccountsSnapshot, AccountView, AccountsResult, AccountsFailure, ProviderInstallationView, ProviderId,
  BeginSetupRequest, SignInRequest, CompleteSetupRequest, LogoutRequest, SetLifecycleRequest, ResolveConflictRequest,
  SetReviewerDefaultRequest, KnownAuthState, SignInMethod, ExternalDefaultOutcome, InstallRecipeView,
} from '../../shared/providers'
import { SIGN_IN_METHODS } from '../../shared/providers'
import { useSettingsStore } from './settingsStore'

interface ProviderAccountsState {
  /** The latest snapshot the main process published; null until the first
   *  answer, and when the main process has no Accounts service. */
  snapshot: AccountsSnapshot | null
  /** The first snapshot request has answered (a null answer included). */
  loaded: boolean
  /** Subscribe once (process lifetime) and fetch the current snapshot. */
  hydrate: () => Promise<void>
  /** A pushed snapshot. Pushes arrive in order, so the latest always wins. */
  receive: (snapshot: AccountsSnapshot) => void
}

// Module-level, like the canvas and registry listeners: the subscription is
// armed once per renderer lifetime and never torn down on unmount.
let subscribed = false

export const useProviderAccountsStore = create<ProviderAccountsState>((set, get) => ({
  snapshot: null,
  loaded: false,
  hydrate: async () => {
    const api = window.electronAPI?.providerAccounts
    if (!api) { set({ loaded: true }); return }
    // Subscribe BEFORE the fetch so a change landing in between is not lost.
    if (!subscribed) {
      subscribed = true
      api.onChanged((s) => get().receive(s))
    }
    let fetched: AccountsSnapshot | null = null
    try { fetched = await api.snapshot() } catch { fetched = null }
    const current = get().snapshot
    // A push that arrived while the fetch was in flight is newer or equal:
    // never let the fetch's answer roll it back.
    if (fetched && (!current || fetched.revision >= current.revision)) set({ snapshot: fetched, loaded: true })
    else set({ loaded: true })
  },
  receive: (snapshot) => set({ snapshot, loaded: true }),
}))

// ---------------------------------------------------------------------------
// Actions: thin wrappers over the preload API. Each returns the main
// process's AccountsResult; an IPC that throws becomes a user-safe failure.
// ---------------------------------------------------------------------------

const DID_NOT_WORK: AccountsFailure = { ok: false, code: 'internal', message: 'That did not work; try again.' }

async function call<T extends object>(run: () => Promise<AccountsResult<T>> | undefined): Promise<AccountsResult<T>> {
  try {
    const r = await run()
    return r && typeof r === 'object' && 'ok' in r ? r : DID_NOT_WORK
  } catch {
    return DID_NOT_WORK
  }
}

const api = () => window.electronAPI.providerAccounts

/** Where each provider's on/off is saved: the same keys main reads (each
 *  package's `enablement.settingsKey`). Main's own switch is held only until
 *  the saved setting says otherwise, so a choice made here is saved too. */
export const PROVIDER_ENABLED_SETTING: Readonly<Record<ProviderId, 'claudeEnabled' | 'codexEnabled'>> = Object.freeze({
  claude: 'claudeEnabled',
  codex: 'codexEnabled',
})

/** The saved setting says the provider is off. */
export function savedOff(settings: { claudeEnabled?: boolean; codexEnabled?: boolean }, providerId: ProviderId): boolean {
  return settings[PROVIDER_ENABLED_SETTING[providerId]] === false
}

export const providerAccountActions = {
  setEnabled: (providerId: ProviderId, enabled: boolean) => call(() => api().setEnabled(providerId, enabled)),
  /** Look for the provider's CLI again. Main keeps what it finds as the
   *  executable its launches and sign-ins run, and pushes a new snapshot. */
  discover: (providerId: ProviderId) => call<{ installation: ProviderInstallationView }>(() => api().discover(providerId)),
  /** How the provider's CLI is installed or updated, to show; never run by
   *  main. Null when main could not say. */
  installRecipes: async (providerId: ProviderId): Promise<InstallRecipeView[] | null> => {
    try {
      const r = await api().installRecipes(providerId)
      return Array.isArray(r) ? r : null
    } catch {
      return null
    }
  },
  /** Turn a provider on or off. Main decides first, so its refusals (in use,
   *  the last provider on) come back unchanged and nothing is saved; once
   *  it agrees, the saved setting is written so the choice outlives main's
   *  in-memory switch and a restart. */
  switchProvider: async (providerId: ProviderId, enabled: boolean): Promise<AccountsResult> => {
    const r = await call(() => api().setEnabled(providerId, enabled))
    if (!r.ok) return r
    try {
      await useSettingsStore.getState().updateSettings({ [PROVIDER_ENABLED_SETTING[providerId]]: enabled })
    } catch {
      return { ok: false, code: 'persist-failed', message: 'The change could not be saved.' }
    }
    return r
  },
  beginSetup: (req: BeginSetupRequest) => call<{ accountId: string }>(() => api().beginSetup(req)),
  issueSecretHandle: (accountId: string) => call<{ handle: string }>(() => api().issueSecretHandle(accountId)),
  signIn: (req: SignInRequest) => call<{ state: KnownAuthState }>(() => api().signIn(req)),
  /** An existing managed account's sign-in, run again in its own realm. */
  signInAgain: (req: SignInRequest) => call<{ state: KnownAuthState }>(() => api().signInAgain(req)),
  cancelSignIn: (accountId: string) => call(() => api().cancelSignIn(accountId)),
  completeSetup: (req: CompleteSetupRequest) => call<{ accountId: string }>(() => api().completeSetup(req)),
  abandonSetup: (accountId: string) => call(() => api().abandonSetup(accountId)),
  logout: (req: LogoutRequest) => call<{ state: KnownAuthState }>(() => api().logout(req)),
  setLifecycle: (req: SetLifecycleRequest) => call(() => api().setLifecycle(req)),
  setDefault: (accountId: string) => call(() => api().setDefault(accountId)),
  adoptExternal: (providerId: ProviderId) => call<{ accountId: string }>(() => api().adoptExternal(providerId)),
  /** The one-time start-up check of the provider's own sign-in, run again
   *  once the user has said they use the provider. */
  runMigration: (providerId: ProviderId) => call<{ outcome: ExternalDefaultOutcome }>(() => api().runMigration(providerId)),
  reconcileSignIn: (accountId: string) => call<{ state: KnownAuthState }>(() => api().reconcileSignIn(accountId)),
  /** "Check sign-in": asks the provider, in the account's own realm, whether
   *  it is signed in now (for Codex, `codex login status`), and records the
   *  answer as the account's last known state. It vouches for nothing: a
   *  realm that now holds another kind of credential is blocked, as every
   *  check does, and only "This is still my account" clears that. */
  checkSignIn: (accountId: string) => call<{ state: KnownAuthState }>(() => api().refreshStatus(accountId)),
  resolveConflict: (req: ResolveConflictRequest) => call(() => api().resolveConflict(req)),
  setReviewerDefault: (req: SetReviewerDefaultRequest) => call(() => api().setReviewerDefault(req)),
}

// ---------------------------------------------------------------------------
// Pure selectors (unit-tested in tests/unit/renderer/provider-accounts-store.test.ts)
// ---------------------------------------------------------------------------

/** The name shown when an account has neither a friendly name nor a label. */
export const ACCOUNT_NAME_FALLBACK = 'Unnamed account'

export function providerView(snapshot: AccountsSnapshot | null, providerId: ProviderId): ProviderInstallationView | undefined {
  return snapshot?.providers.find((p) => p.providerId === providerId)
}

/** A provider's accounts as a surface lists them: active ones first, then
 *  inactive ones, each in the snapshot's order. Archived accounts are hidden. */
export function selectProviderAccounts(snapshot: AccountsSnapshot | null, providerId: ProviderId): AccountView[] {
  const mine = (snapshot?.accounts ?? []).filter((a) => a.providerId === providerId && a.lifecycle !== 'archived')
  return [...mine.filter((a) => a.lifecycle === 'active'), ...mine.filter((a) => a.lifecycle === 'inactive')]
}

/** The registry account mirroring one of the provider's own accounts (a
 *  Claude profile), by the provider's id for it. */
export function accountForLegacyId(snapshot: AccountsSnapshot | null, providerId: ProviderId, legacyId: string): AccountView | undefined {
  return snapshot?.accounts.find((a) => a.providerId === providerId && a.legacyId === legacyId)
}

/** The identity's friendly name, else the provider's label for the account
 *  (its email), else a short fallback. The provider's shared external home
 *  is always named for what it is ("This computer's Codex (~/.codex)"),
 *  whatever its identity is called: whether it is vouched for comes from the
 *  account's flags, never from a name. */
export function accountDisplayName(snapshot: AccountsSnapshot | null, account: AccountView): string {
  if (account.external) {
    const p = providerView(snapshot, account.providerId)
    return externalHomeLabel(p ?? { providerId: account.providerId, displayName: account.providerId })
  }
  const friendly = snapshot?.identities.find((i) => i.id === account.identityId)?.friendlyName?.trim()
  if (friendly) return friendly
  const label = account.providerLabel?.trim()
  if (label) return label
  return ACCOUNT_NAME_FALLBACK
}

/** What the reviewer line under a provider's section says. `label` is the
 *  parenthesised suffix: `reviewer` only for a chosen reviewer that can run
 *  here (a refused account is never shown as the reviewer), `default` when
 *  reviews fall back to the provider default. */
export type ReviewerLine =
  | { kind: 'no-account' }
  | { kind: 'account'; accountId: string; name: string; label: 'reviewer' | 'default' | null; ready: boolean }

/** Null when the provider does not review for the other provider here. */
export function reviewerLine(snapshot: AccountsSnapshot | null, providerId: ProviderId): ReviewerLine | null {
  const review = providerView(snapshot, providerId)?.review
  if (!review) return null
  if (!review.accountId) return { kind: 'no-account' }
  const account = snapshot?.accounts.find((a) => a.id === review.accountId)
  const name = account ? accountDisplayName(snapshot, account) : ACCOUNT_NAME_FALLBACK
  const refused = !!account?.reviewRefusal
  const label = review.source === 'reviewer-default' ? (refused ? null : 'reviewer') : review.source === 'provider-default' ? 'default' : null
  return { kind: 'account', accountId: review.accountId, name, label, ready: review.ready && !refused }
}

/** Whether an account may be offered "Make reviewer": an active account of
 *  a provider that reviews here, not blocked, vouched for (not unverified,
 *  not the provider's shared external home), with nothing stopping it from
 *  running reviews on this platform, and not already the reviewer. */
export function canOfferMakeReviewer(snapshot: AccountsSnapshot | null, account: AccountView): boolean {
  if (account.lifecycle !== 'active') return false
  if (account.operationalState === 'blocked') return false
  if (account.unverified || account.external) return false
  if (account.reviewRefusal) return false
  if (account.isReviewerDefault) return false
  return !!providerView(snapshot, account.providerId)?.review
}

/** Whether an account may be offered "Sign in again": one this app manages
 *  (not the provider's shared external home), not archived, not blocked (it
 *  is reconciled first), and not signed in now (the provider never logs in
 *  over a realm that is still signed in). */
export function canOfferSignInAgain(account: AccountView): boolean {
  if (account.external) return false
  if (account.lifecycle === 'archived') return false
  if (account.operationalState === 'blocked') return false
  return account.lastKnownAuthState !== 'signed-in'
}

/** The methods "Sign in again" offers: the account's recorded family only
 *  (a browser or device sign-in again as either; an API key again as a key),
 *  of those enabled here, with the recorded method selected first. An
 *  account whose method is not recorded may use any enabled method. */
export function signInAgainMethods(p: ProviderInstallationView, account: Pick<AccountView, 'authMethod'>): { methods: SignInMethod[]; preselected: SignInMethod | null } {
  const family: readonly SignInMethod[] = account.authMethod === 'apiKey' ? ['apiKey']
    : account.authMethod === 'browser' || account.authMethod === 'device' ? ['browser', 'device']
    : SIGN_IN_METHODS
  const methods = SIGN_IN_METHODS.filter((m) => family.includes(m) && p.signInMethods[m]?.enabled)
  const recorded = (methods as readonly string[]).includes(account.authMethod) ? account.authMethod as SignInMethod : null
  return { methods, preselected: recorded ?? methods[0] ?? null }
}

// Lifecycle offers mirror the registry's own rules (setAccountLifecycle in
// src/shared/providers/registry.ts), so no row offers a change the registry
// always refuses. Refusals that depend on the moment (something is using
// the account) still come back as messages.

/** "Make inactive": an active account, unless it is the provider default
 *  while another account of the provider is active (another default is
 *  chosen first), or it mirrors the provider's own list and that list
 *  refuses it (its primary account, or its last active one). */
export function canOfferMakeInactive(snapshot: AccountsSnapshot | null, account: AccountView): boolean {
  if (account.lifecycle !== 'active') return false
  const others = (snapshot?.accounts ?? []).filter((a) => a.id !== account.id && a.providerId === account.providerId && a.lifecycle === 'active')
  if (account.legacyLinked && (account.isProviderDefault || !others.some((a) => a.legacyLinked))) return false
  if (account.isProviderDefault && others.length > 0) return false
  return true
}

/** "Make active": an inactive account that is not blocked (a blocked one is
 *  reconciled first). */
export function canOfferMakeActive(account: AccountView): boolean {
  return account.lifecycle === 'inactive' && account.operationalState !== 'blocked'
}

/** "Archive": only an inactive account, and never one mirrored from the
 *  provider's own list (it is removed where it was created). */
export function canOfferArchive(account: AccountView): boolean {
  return account.lifecycle === 'inactive' && !account.legacyLinked
}

/** What the Accounts surface says about using the provider's own sign-in on
 *  this computer, from the one-time start-up check (docs/wp2/plan.md, the
 *  slice 3e notes). Nothing until that check has settled, while a setup of
 *  that home is pending, or once an account stands for it. A skipped check
 *  says why; "Check again" (the explicit adoption) is offered where the
 *  check could not get an answer. */
export type ExternalAdoptionView =
  | { kind: 'none' }
  | { kind: 'note'; text: string }
  /** The check waits for the user to say they use the provider. */
  | { kind: 'confirm'; text: string }
  | { kind: 'offer'; text: string | null; action: 'check-again' | 'use' }

export function externalAdoption(snapshot: AccountsSnapshot | null, providerId: ProviderId): ExternalAdoptionView {
  const none: ExternalAdoptionView = { kind: 'none' }
  const p = providerView(snapshot, providerId)
  const ext = snapshot?.externalDefaults.find((e) => e.providerId === providerId)
  if (!snapshot || !p || !ext || !p.enabled) return none
  if (snapshot.pendingSetups.some((s) => s.providerId === providerId && s.external)) return none
  if (snapshot.accounts.some((a) => a.providerId === providerId && a.external && a.lifecycle !== 'archived')) return none
  const name = p.displayName
  const folder = providerId === 'codex' ? ` sign-in folder (~/.codex)` : ' sign-in folder'
  const m = ext.marker
  if (!m) {
    if (ext.needsConfirmation) return { kind: 'confirm', text: `This computer's ${name} sign-in is checked once you confirm you use ${name}.` }
    if (ext.lastRun === 'retry-later') return { kind: 'note', text: `The app could not finish checking this computer's ${name} sign-in; it checks again at the next start.` }
    return none
  }
  if (m.outcome === 'registered') return { kind: 'offer', text: null, action: 'use' }
  if (m.outcome === 'none') return { kind: 'offer', text: `When the app first checked, this computer's ${name} was signed out.`, action: 'use' }
  switch (m.reason) {
    case 'unavailable': return { kind: 'offer', text: `The app could not check this computer's ${name} sign-in when it first tried: it timed out, did not start, or ${name} was busy.`, action: 'check-again' }
    case 'no-answer': return { kind: 'offer', text: `${name} did not say whether this computer's sign-in is signed in when the app first checked.`, action: 'check-again' }
    case 'off': return { kind: 'offer', text: `${name} was off when the app first checked, so this computer's sign-in was not looked at.`, action: 'use' }
    case 'no-cli': return { kind: 'offer', text: `The ${name} CLI was not found when the app first checked.`, action: 'use' }
    case 'cli-unsupported': return { kind: 'offer', text: `The ${name} CLI on this computer was a version this app does not support when it first checked.`, action: 'use' }
    case 'home-missing': return { kind: 'offer', text: `There was no ${name}${folder} on this computer when the app first checked.`, action: 'use' }
    case 'overlap': return { kind: 'note', text: `This computer's ${name} folder overlaps this app's own account folders, so it cannot be used here.` }
    default: return { kind: 'offer', text: `The app did not check this computer's ${name} sign-in.`, action: 'use' }
  }
}

/** A failed sign-in-again as its dialog says it. */
export function signInAgainFailureText(r: AccountsFailure): string {
  if (r.code === 'sign-in-changed') return 'This account now holds a different sign-in. Use "This is still my account" on its row first.'
  return accountFailureText(r)
}

/** Whether a row may wear the Reviewer badge: never an account that cannot
 *  run reviews here, even while the registry still names it. */
export function showsReviewerBadge(account: AccountView): boolean {
  return account.isReviewerDefault && !account.reviewRefusal && !account.unverified && !account.external
}

/** The one notice shown under a provider's reviewer line when the app
 *  cleared an earlier reviewer choice. Claude on macOS has its own sentence
 *  (the platform rule behind the clearing); anything else says the choice
 *  was cleared and gives the main process's reason. */
export function reviewerNotice(snapshot: AccountsSnapshot | null, providerId: ProviderId, platform: string): string | null {
  const notice = snapshot?.reviewerNotices.find((n) => n.providerId === providerId)
  if (!notice) return null
  if (providerId === 'claude' && platform === 'darwin') {
    return 'Your earlier Claude reviewer was cleared: on macOS only the normal Claude sign-in can be the Claude reviewer.'
  }
  const name = providerId === 'claude' ? 'Claude' : (providerView(snapshot, providerId)?.displayName ?? providerId)
  return `Your earlier ${name} reviewer was cleared. ${notice.message}`.trim()
}

/** "This account is in use (3)." The count is everything holding the
 *  account (sessions, reviews, sign-ins, operations), so it is never called
 *  sessions; the row's own running counts, when given, break it down. */
export function inUseText(count: number, running?: Pick<AccountView, 'runningSessions' | 'runningReviews'>): string {
  const base = `This account is in use (${count}).`
  if (!running) return base
  const parts: string[] = []
  if (running.runningSessions > 0) parts.push(running.runningSessions === 1 ? '1 session' : `${running.runningSessions} sessions`)
  if (running.runningReviews > 0) parts.push(running.runningReviews === 1 ? '1 review' : `${running.runningReviews} reviews`)
  return parts.length ? `${base} Running now: ${parts.join(', ')}.` : base
}

/** A failure as a row shows it: how much holds the account when the main
 *  process refused for that, else its message. */
export function accountFailureText(r: AccountsFailure, running?: Pick<AccountView, 'runningSessions' | 'runningReviews'>): string {
  if (r.code === 'consumers' && typeof r.consumers === 'number' && r.consumers > 0) return inUseText(r.consumers, running)
  return r.message
}

export type StatusTone = 'ok' | 'warn' | 'muted'

/** Where a provider's own shared sign-in lives, as the surface names it. */
export function externalHomeLabel(p: Pick<ProviderInstallationView, 'providerId' | 'displayName'>): string {
  return p.providerId === 'codex' ? "This computer's Codex (~/.codex)" : `This computer's ${p.displayName}`
}

/** How an account signed in, as a row says it; null when unknown or when
 *  it is the provider's own external home. */
export function signInMethodLabel(account: Pick<AccountView, 'authMethod'>, p: Pick<ProviderInstallationView, 'providerId' | 'displayName'>): string | null {
  switch (account.authMethod) {
    case 'browser': return p.providerId === 'codex' ? 'ChatGPT sign-in' : 'Browser sign-in'
    case 'device': return 'Device code'
    case 'apiKey': return 'API key'
    // The external home is named by the row's title; its method says nothing more.
    default: return null
  }
}

/** An account's sign-in state as a row says it. A blocked account (a check
 *  found it signed in a different way than before, such as an API key where
 *  there was a ChatGPT sign-in) says so before anything else. */
export function accountState(account: Pick<AccountView, 'operationalState' | 'lastKnownAuthState'>): { text: string; tone: StatusTone } {
  if (account.operationalState === 'blocked') return { text: 'Needs attention: signed in a different way than before', tone: 'warn' }
  switch (account.lastKnownAuthState) {
    case 'signed-in': return { text: 'Signed in', tone: account.operationalState === 'attention' ? 'warn' : 'ok' }
    case 'signed-out': return { text: 'Signed out', tone: 'warn' }
    case 'expired': return { text: 'Expired', tone: 'warn' }
    case 'error': return { text: "Couldn't check the sign-in", tone: 'warn' }
    case 'unsupported': return { text: "Can't check the sign-in here", tone: 'muted' }
    default: return { text: 'Not checked yet', tone: 'muted' }
  }
}

/** "Check sign-in" is offered on an account the provider can check now: the
 *  provider is on and its status check is enabled, and the account is not
 *  blocked (a blocked one gets "This is still my account", which checks and
 *  vouches). */
export function canOfferCheckSignIn(account: Pick<AccountView, 'operationalState' | 'lifecycle'>, provider: Pick<ProviderInstallationView, 'enabled' | 'status'>): boolean {
  return provider.enabled && provider.status.enabled && account.operationalState !== 'blocked' && account.lifecycle !== 'archived'
}

/** What a "Check sign-in" answered, as its row says it. */
export function signInCheckText(state: KnownAuthState): string {
  switch (state) {
    case 'signed-in': return 'Checked just now: signed in.'
    case 'signed-out': return 'Checked just now: signed out.'
    case 'expired': return 'Checked just now: the sign-in has expired.'
    case 'unsupported': return "Checked just now: this sign-in can't be checked here."
    case 'error': return "Checked just now: the sign-in couldn't be read."
    default: return 'Checked just now: no clear answer.'
  }
}

/** The command that signs in to a provider's own home on this computer, where
 *  the provider has one; the app never signs in there itself (external
 *  realms refuse sign-in). */
const EXTERNAL_SIGN_IN_COMMAND: Readonly<Partial<Record<ProviderId, string>>> = Object.freeze({ codex: 'codex login' })

/** What a signed-out or expired row for the provider's own home on this
 *  computer says to do, or null when there is nothing to say. */
export function externalSignInHint(account: Pick<AccountView, 'external' | 'lastKnownAuthState' | 'operationalState'>, provider: Pick<ProviderInstallationView, 'providerId'>): string | null {
  if (!account.external || account.operationalState === 'blocked') return null
  if (account.lastKnownAuthState !== 'signed-out' && account.lastKnownAuthState !== 'expired') return null
  const command = EXTERNAL_SIGN_IN_COMMAND[provider.providerId]
  return command ? `Run ${command} in a terminal, then Check sign-in.` : null
}

/** A provider's machine status as the Providers card says it
 *  ("Claude Code 2.1.281 - ready"). */
export function providerStatus(p: ProviderInstallationView): { text: string; tone: StatusTone } {
  const named = p.version ? `${p.displayName} ${p.version}` : p.displayName
  if (!p.enabled) return { text: 'Off', tone: 'muted' }
  switch (p.discoveryState) {
    case 'unchecked': return { text: `${p.displayName}: not checked yet`, tone: 'muted' }
    case 'missing': return { text: `${p.displayName} was not found on this computer`, tone: 'warn' }
    case 'invalid': return { text: `${p.displayName} was found but did not run as expected`, tone: 'warn' }
    case 'error': return { text: `${p.displayName} could not be checked`, tone: 'warn' }
    case 'found':
    default:
      switch (p.compatibility) {
        case 'supported': return { text: `${named} - ready`, tone: 'ok' }
        case 'too-old': return { text: `${named} is too old for this app; update it`, tone: 'warn' }
        case 'too-new': return { text: `${named} is newer than this app supports`, tone: 'warn' }
        case 'unsupported': return { text: `${named} is not supported here`, tone: 'warn' }
        default: return { text: `${named} found`, tone: 'muted' }
      }
  }
}
