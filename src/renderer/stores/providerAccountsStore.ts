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
  BeginSetupRequest, SignInRequest, SignInAgainRequest, CompleteSetupRequest, LogoutRequest, SetLifecycleRequest, ResolveConflictRequest,
  SetReviewerDefaultRequest, KnownAuthState, SignInMethod, InstallRecipeView, UpdateIdentityRequest, IdentityView,
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

/** Where the user's ANSWER about a provider is saved, for a provider whose
 *  on/off counts only once it was given in this model: the same key main
 *  reads (the package's `enablement.answeredKey`). Codex only: every user
 *  who updates chooses again, and an earlier build's Codex setting does not
 *  carry over (owner decision 2026-09-26). Claude Code has none: its absent
 *  value is on. */
export const PROVIDER_ANSWERED_SETTING: Readonly<Partial<Record<ProviderId, 'codexAnswered'>>> = Object.freeze({
  codex: 'codexAnswered',
})

/** The saved setting says the provider is off. */
export function savedOff(settings: { claudeEnabled?: boolean; codexEnabled?: boolean }, providerId: ProviderId): boolean {
  return settings[PROVIDER_ENABLED_SETTING[providerId]] === false
}

/** A save that did not land: said as such, never as a success. */
export const PERSIST_FAILED: AccountsResult = { ok: false, code: 'persist-failed', message: 'The change could not be saved.' }

/** Write a provider's saved on/off, and with it the answer (a switch made by
 *  the user is always an answer: PROVIDER_ANSWERED_SETTING). True only once
 *  the save has landed: updateSettings RESOLVES false when the config save
 *  fails (config-saver), and may also throw. */
export async function saveProviderSwitch(providerId: ProviderId, enabled: boolean): Promise<boolean> {
  const answered = PROVIDER_ANSWERED_SETTING[providerId]
  try {
    return (await useSettingsStore.getState().updateSettings({
      [PROVIDER_ENABLED_SETTING[providerId]]: enabled,
      ...(answered ? { [answered]: true } : {}),
    })) !== false
  } catch {
    return false
  }
}

/** The user has not said yet whether they use the provider: "not set up".
 *  Main reads its saved on/off as "not answered yet" (the view's
 *  preference) and refuses its launches until they do (the launch rule's
 *  "not set up"). Only a provider whose on/off counts once answered
 *  (PROVIDER_ANSWERED_SETTING: Codex) can be unanswered: Claude Code's
 *  absent value is on, so a Claude preference main could not read is the
 *  settings file's fault, never "not set up". */
export function providerNotSetUp(p: Pick<ProviderInstallationView, 'providerId' | 'preference'> | undefined): boolean {
  return p?.preference === 'undecided' && PROVIDER_ANSWERED_SETTING[p.providerId] !== undefined
}

/** providerNotSetUp, for a provider of the snapshot. */
export function providerUnanswered(snapshot: AccountsSnapshot | null, providerId: ProviderId): boolean {
  return providerNotSetUp(providerView(snapshot, providerId))
}

/** On, as the user answered it: switched on, and not "not answered yet".
 *  What a surface asks before it offers anything that runs the provider's
 *  CLI: main refuses the rest (its account operations need the same). */
export function providerAnsweredOn<T extends Pick<ProviderInstallationView, 'enabled' | 'preference'>>(p: T | undefined): p is T {
  return !!p?.enabled && p.preference === 'on'
}

/** Adding an account of a provider the user has not answered for is their
 *  yes (owner decision 2026-09-26): record it (on, and answered) before the
 *  account is set up. It never adopts the provider's own sign-in on this
 *  computer. Nothing to do once answered. */
export async function answerYesIfUnanswered(providerId: ProviderId): Promise<AccountsResult> {
  if (!providerUnanswered(useProviderAccountsStore.getState().snapshot, providerId)) return { ok: true }
  return providerAccountActions.switchProvider(providerId, true)
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
    return (await saveProviderSwitch(providerId, enabled)) ? r : PERSIST_FAILED
  },
  beginSetup: (req: BeginSetupRequest) => call<{ accountId: string }>(() => api().beginSetup(req)),
  issueSecretHandle: (accountId: string) => call<{ handle: string }>(() => api().issueSecretHandle(accountId)),
  signIn: (req: SignInRequest) => call<{ state: KnownAuthState }>(() => api().signIn(req)),
  /** An existing managed account's sign-in, run again in its own realm. */
  signInAgain: (req: SignInAgainRequest) => call<{ state: KnownAuthState; separateAccountId?: string }>(() => api().signInAgain(req)),
  cancelSignIn: (accountId: string) => call(() => api().cancelSignIn(accountId)),
  completeSetup: (req: CompleteSetupRequest) => call<{ accountId: string }>(() => api().completeSetup(req)),
  abandonSetup: (accountId: string) => call(() => api().abandonSetup(accountId)),
  logout: (req: LogoutRequest) => call<{ state: KnownAuthState }>(() => api().logout(req)),
  setLifecycle: (req: SetLifecycleRequest) => call(() => api().setLifecycle(req)),
  setDefault: (accountId: string) => call(() => api().setDefault(accountId)),
  /** The ONLY way this computer's own sign-in of a provider is taken in
   *  (Codex's ~/.codex): the user's explicit "Use this sign-in". Main asks
   *  the provider's status there first and registers it only when it is
   *  signed in. Nothing adopts it automatically (owner decision 2026-09-26),
   *  so this store has no action for the old start-up check. */
  adoptExternal: (providerId: ProviderId) => call<{ accountId: string }>(() => api().adoptExternal(providerId)),
  /** Whether this computer's own sign-in of a provider is signed in, asked
   *  WITHOUT taking it in: main runs the same status check as adoptExternal
   *  and keeps nothing. The Set up Codex page asks it before it offers "Use
   *  this sign-in" as signed in. */
  probeExternal: (providerId: ProviderId) => call<{ state: KnownAuthState }>(() => api().probeExternal(providerId)),
  reconcileSignIn: (accountId: string) => call<{ state: KnownAuthState }>(() => api().reconcileSignIn(accountId)),
  /** "Check sign-in": asks the provider, in the account's own realm, whether
   *  it is signed in now (for Codex, `codex login status`), and records the
   *  answer as the account's last known state. It vouches for nothing: a
   *  realm that now holds another kind of credential is blocked, as every
   *  check does, and only "This is still my account" clears that. */
  checkSignIn: (accountId: string) => call<{ state: KnownAuthState }>(() => api().refreshStatus(accountId)),
  resolveConflict: (req: ResolveConflictRequest) => call(() => api().resolveConflict(req)),
  setReviewerDefault: (req: SetReviewerDefaultRequest) => call(() => api().setReviewerDefault(req)),
  /** The identity editor (P3.2, design 5.1, 5.2): name, colour and group
   *  are the identity's, shown on every account linked to it. */
  updateIdentity: (req: UpdateIdentityRequest) => call(() => api().updateIdentity(req)),
  createGroup: (name: string) => call<{ groupId: string }>(() => api().createGroup(name)),
  /** Point an account at another identity (link), or give it a private copy
   *  of its current one (unlink). Main refuses what the rules forbid (an
   *  unverified sign-in is never linked). */
  linkIdentity: (accountId: string, identityId: string) => call(() => api().linkIdentity(accountId, identityId)),
  unlinkIdentity: (accountId: string) => call<{ identityId: string }>(() => api().unlinkIdentity(accountId)),
  /** "Restore" on an archived account: main brings it back INACTIVE, with
   *  nothing about its sign-in trusted; "Make active" then checks it. */
  restore: (accountId: string) => call(() => api().setLifecycle({ accountId, lifecycle: 'inactive' })),
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

/** A provider's archived accounts ("Archived (N)", design 5.3), in the
 *  snapshot's order. */
export function selectArchivedAccounts(snapshot: AccountsSnapshot | null, providerId: ProviderId): AccountView[] {
  return (snapshot?.accounts ?? []).filter((a) => a.providerId === providerId && a.lifecycle === 'archived')
}

/** "Restore": an archived account that is not mirrored from the provider's
 *  own list (that one comes back where it was removed). */
export function canOfferRestore(account: AccountView): boolean {
  return account.lifecycle === 'archived' && !account.legacyLinked
}

export function identityOf(snapshot: AccountsSnapshot | null, account: Pick<AccountView, 'identityId'>): IdentityView | undefined {
  return snapshot?.identities.find((i) => i.id === account.identityId)
}

/** The other live accounts that share this account's identity: the "Linked
 *  with" line and the identity editor's list. Archived ones are history. */
export function linkedAccounts(snapshot: AccountsSnapshot | null, account: AccountView): AccountView[] {
  return (snapshot?.accounts ?? []).filter((a) => a.id !== account.id && a.identityId === account.identityId && a.lifecycle !== 'archived')
}

/** What the "Linked with" line names for a linked account: the provider's
 *  label for it (Claude: the email), else its display name. */
export function linkedAccountLabel(snapshot: AccountsSnapshot | null, account: AccountView): string {
  return account.providerLabel?.trim() || accountDisplayName(snapshot, account)
}

/** Whether an account's identity can be linked at all: an unverified or
 *  external sign-in keeps its own identity (its attribution is a guess). */
export function canLinkIdentity(account: Pick<AccountView, 'unverified' | 'external'>): boolean {
  return !account.unverified && !account.external
}

/** Accounts the identity editor offers under "Link another account": what
 *  main accepts (linkAccountIdentity) -- live, vouched-for accounts on
 *  another identity, and never a record of a provider's own list (a Claude
 *  profile) when a record of that same list is already on this identity,
 *  live or archived -- of a provider that is on (one that is off offers
 *  nothing, as it manages nothing). */
export function linkCandidates(snapshot: AccountsSnapshot | null, account: AccountView): AccountView[] {
  if (!canLinkIdentity(account)) return []
  const accounts = snapshot?.accounts ?? []
  // Records of a provider's own list on this identity (an archived one is no
  // longer linked, and only a provider's own list archives it this way).
  const listRecordHere = (a: AccountView) => accounts.some((b) => b.id !== a.id && b.identityId === account.identityId
    && b.providerId === a.providerId && (b.legacyLinked || b.lifecycle === 'archived'))
  return accounts.filter((a) => a.identityId !== account.identityId && a.lifecycle !== 'archived' && canLinkIdentity(a)
    && !(a.legacyLinked && listRecordHere(a)) && providerView(snapshot, a.providerId)?.enabled !== false)
}

/** The session facts the Accounts rows read (a structural subset of the
 *  renderer's Session, so this module imports no session store). */
export interface AccountSessionFacts {
  id: string
  label: string
  customName?: string
  provider?: ProviderId
  sessionType?: string
  shellOnly?: boolean
  profileId?: string
  ptyExited?: boolean
  neverStarted?: boolean
}

export function sessionTitle(s: Pick<AccountSessionFacts, 'label' | 'customName'>): string {
  return s.customName?.trim() || s.label
}

/** The Claude sessions running on a Claude profile now: local, not a plain
 *  shell, started and not ended, on that profile (a session that names none
 *  runs on the primary, as the header's account pill resolves it). Claude
 *  sessions hold no account lease, so this is the "N running" for a Claude
 *  row. */
export function claudeSessionsOnProfile(sessions: readonly AccountSessionFacts[], profileId: string, primaryId: string | undefined): AccountSessionFacts[] {
  return sessions.filter((s) => (s.provider ?? 'claude') === 'claude' && s.sessionType === 'local' && !s.shellOnly && !s.ptyExited && !s.neverStarted
    && (s.profileId ?? primaryId) === profileId)
}

/** How many holders a refusal counts that this window cannot name: main's
 *  own unnamed count, plus the named sessions not open here. */
export function unnamedHolders(ids: readonly string[] | undefined, named: readonly { id: string }[], unnamed: number | undefined): number {
  const here = new Set(named.map((s) => s.id))
  return (unnamed ?? 0) + (ids ?? []).filter((id) => !here.has(id)).length
}

/** The sessions a refusal named that this window has open, for "Go to". */
export function blockerSessions(sessions: readonly AccountSessionFacts[], ids: readonly string[] | undefined): AccountSessionFacts[] {
  if (!ids?.length) return []
  const wanted = new Set(ids)
  return sessions.filter((s) => wanted.has(s.id))
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
    return externalHomeLabel(p ?? { providerId: account.providerId, displayName: account.providerId }, externalHomeFolder(snapshot, account.providerId))
  }
  const friendly = snapshot?.identities.find((i) => i.id === account.identityId)?.friendlyName?.trim()
  if (friendly) return friendly
  const label = account.providerLabel?.trim()
  if (label) return label
  // An unnamed identity shared with a labelled account (a Claude profile's
  // email): that label names the person here too.
  const linked = (snapshot?.accounts ?? []).find((a) => a.id !== account.id && a.identityId === account.identityId && a.lifecycle !== 'archived' && a.providerLabel?.trim())
  if (linked) return linked.providerLabel!.trim()
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

/** Whether an account may be offered "Sign in again": not archived and not
 *  blocked (it is reconciled first). Signed in too (P3.3, design 9.2): main
 *  then signs in to a new folder and moves the account there only once that
 *  sign-in is verified, so the one it has is never lost on the way. This
 *  computer's own sign-in too, in place, after its warning is confirmed
 *  (design 9.2, last paragraph). */
export function canOfferSignInAgain(account: AccountView): boolean {
  if (account.lifecycle === 'archived') return false
  return account.operationalState !== 'blocked'
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
 *  this computer (Codex's ~/.codex). The app never takes it in on its own
 *  (owner decision 2026-09-26): it is looked at only when the user chooses
 *  "Use this computer's ... sign-in" (the explicit adoption). Nothing while a
 *  setup of that home is pending, or once an account stands for it. While
 *  the user has not said they use the provider, the block asks only that
 *  (the yes records the answer; it adopts nothing). With the provider on and
 *  nothing recorded, the offer. A recorded answer says what it found:
 *  `registered` is the user's own adoption (its account archived since);
 *  `none` and `skipped` only a development build's start-up check could
 *  record, before owner decision 2026-09-26, and they are read here so such
 *  a registry still says something true ("Check again" is the adoption,
 *  asked again, where that check could not get an answer). */
export type ExternalAdoptionView =
  | { kind: 'none' }
  | { kind: 'note'; text: string }
  /** The user has not said they use the provider: ask that first. */
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
  const home = externalHomeFolder(snapshot, providerId)
  const folder = home ? ` sign-in folder (${home})` : ' sign-in folder'
  if (providerNotSetUp(p)) {
    return { kind: 'confirm', text: `${name} is not set up yet. Once you say you use ${name}, you can use this computer's ${name} sign-in here.` }
  }
  const m = ext.marker
  // True whether or not the Set up Codex page has checked it (read-only, and
  // keeping nothing): what waits for the user is using it.
  if (!m) {
    return { kind: 'offer', text: `This app uses this computer's ${name} sign-in only when you choose to use it. Choosing it asks ${name} first whether it is signed in.`, action: 'use' }
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

/** The folder a provider's own shared sign-in lives in, as main names it
 *  for display (Codex: ~/.codex when no CODEX_HOME is set, else the folder
 *  CODEX_HOME named when the app started), or null when main names none: a
 *  CODEX_HOME that is set but unusable, no home folder, or no snapshot yet.
 *  Never guessed: a surface with null names no folder (externalHomeLabel,
 *  externalHomeWhere). */
export function externalHomeFolder(snapshot: AccountsSnapshot | null, providerId: ProviderId): string | null {
  return snapshot?.externalDefaults.find((e) => e.providerId === providerId)?.home ?? null
}

/** Where a provider's own shared sign-in lives, as the surface names it:
 *  with the folder main named (externalHomeFolder), else without one. */
export function externalHomeLabel(p: Pick<ProviderInstallationView, 'providerId' | 'displayName'>, folder: string | null): string {
  return folder ? `This computer's ${p.displayName} (${folder})` : `This computer's ${p.displayName}`
}

/** That folder as a sentence names it: the folder main named, else "this
 *  computer's <provider> folder", which claims none. */
export function externalHomeWhere(snapshot: AccountsSnapshot | null, p: Pick<ProviderInstallationView, 'providerId' | 'displayName'>): string {
  return externalHomeFolder(snapshot, p.providerId) ?? `this computer's ${p.displayName} folder`
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
export function accountState(account: Pick<AccountView, 'operationalState' | 'lastKnownAuthState' | 'oldSignInLeft'>): { text: string; tone: StatusTone } {
  if (account.operationalState === 'blocked') return { text: 'Needs attention: signed in a different way than before', tone: 'warn' }
  // A sign in again moved it to a new sign-in; the old one is still there:
  // kept on purpose, or not removed (oldSignInText says why and what to do).
  if (account.oldSignInLeft === 'kept') return { text: 'Needs attention: the old sign-in is kept', tone: 'warn' }
  if (account.oldSignInLeft) return { text: 'Needs attention: the old sign-in was not removed', tone: 'warn' }
  switch (account.lastKnownAuthState) {
    case 'signed-in': return { text: 'Signed in', tone: account.operationalState === 'attention' ? 'warn' : 'ok' }
    case 'signed-out': return { text: 'Signed out', tone: 'warn' }
    case 'expired': return { text: 'Expired', tone: 'warn' }
    case 'error': return { text: "Couldn't check the sign-in", tone: 'warn' }
    case 'unsupported': return { text: "Can't check the sign-in here", tone: 'muted' }
    default: return { text: 'Not checked yet', tone: 'muted' }
  }
}

/** Why an account's old sign-in is still there, and what removes it (the
 *  row's line under its state). Honest: never "Check sign-in removes it"
 *  when a check will not. */
export function oldSignInText(reason: NonNullable<AccountView['oldSignInLeft']>, providerName: string): string {
  switch (reason) {
    case 'kept': return 'It stays until the app can remove it without signing out the new one. Archiving the account removes it.'
    case 'unavailable': return `It is removed once ${providerName} can sign it out here.`
    case 'failed': return 'Removing it did not finish. Check sign-in tries again.'
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
  // Not answered yet: never "On". Main starts nothing of it (and does not
  // look for its CLI) until the user says they use it.
  if (providerNotSetUp(p)) return { text: `${p.displayName} is not set up yet`, tone: 'muted' }
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
        case 'too-new': return { text: `${named} is newer than the versions this app was tested with; it will still be used`, tone: 'warn' }
        case 'unsupported': return { text: `${named} is not supported here`, tone: 'warn' }
        default: return { text: `${named} found`, tone: 'muted' }
      }
  }
}
