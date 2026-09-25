// src/renderer/utils/launchAccount.ts
//
// WP2 commit 6: which provider account a session launches under, and what the
// user has to be told or asked about it. Pure helpers over the Accounts
// snapshot (stores/providerAccountsStore.ts), shared by the New session
// dialog's account picker and TerminalView's launch, so the two can never
// disagree about which account needs a per-launch confirmation.
//
// The rule mirrors main (accounts-service prepareLaunch): a launch on an
// account nobody has vouched for -- the provider's shared home on this
// computer, or any realm-only sign-in -- needs THAT launch's acknowledgement,
// sent together with the account id it acknowledges. Nothing here stores one.
import type { AccountsSnapshot, AccountView, Compatibility, ProviderId } from '../../shared/providers'
import { accountDisplayName, providerStatus, providerView, useProviderAccountsStore } from '../stores/providerAccountsStore'
import { formatSpawnError } from './sessionLaunch'
import { isConfigLaunchBlocked } from '../hooks/useLaunchConfig'

/**
 * Something the user has to do in Accounts, as a sentence whose own words
 * are the link: `lead`, then `link` (a button where one can be drawn), then
 * `tail`. Where no link can be drawn (the terminal) it reads as one sentence
 * (`noticeText`), so "Open Accounts" never reads twice.
 */
export interface AccountNotice {
  lead: string
  link: string
  tail: string
}

/** An account that cannot launch until it is looked at (inactive, archived
 *  or blocked). */
export const NEEDS_ATTENTION: AccountNotice = { lead: 'This account needs attention.', link: 'Open Accounts', tail: '.' }
/** A blocked account: its home now holds another sign-in (design 5.5). */
export const SIGNED_IN_ELSEWHERE: AccountNotice = { lead: 'This account signed in as someone else.', link: 'Open Accounts', tail: ' and confirm it is still yours.' }
/** No Codex account to start a session on. */
export const NO_ACCOUNT: AccountNotice = { lead: 'Sign in to Codex first.', link: 'Open Accounts', tail: '.' }
/** Discovery has no answer about the CLI a launch would run. */
export const NOT_CHECKED: AccountNotice = { lead: 'This app could not check Codex.', link: 'Open Accounts', tail: '.' }

export const noticeText = (n: AccountNotice): string => `${n.lead} ${n.link}${n.tail}`
export const NEEDS_ATTENTION_TEXT = noticeText(NEEDS_ATTENTION)
export const SIGNED_IN_ELSEWHERE_TEXT = noticeText(SIGNED_IN_ELSEWHERE)

/** Whether a provider's plain "Restart" opens the resume picker (canvas F7).
 *  A Claude restart always has. A Codex session has two restarts: "Restart"
 *  starts a new conversation, "Restart and pick a conversation" opens the
 *  picker (useRestartSession's `pickConversation`). */
export function restartPicksConversation(provider: ProviderId | undefined): boolean {
  return (provider ?? 'claude') !== 'codex'
}

/** WP2: whether a launch of this provider is one main refuses because the
 *  provider is off -- the account list says so, or the saved setting does
 *  (the renderer's launch rule). A launch like that asks the user nothing
 *  (no sign-in confirmation, no account picker): it goes to main, and the
 *  tab shows main's reason. */
export function providerOffForLaunch(providerId: ProviderId, snapshot: AccountsSnapshot | null): boolean {
  return providerView(snapshot, providerId)?.enabled === false || isConfigLaunchBlocked({ provider: providerId, shellOnly: false })
}

/** Whether a launch on this account needs its own acknowledgement. */
export function launchNeedsAcknowledgement(account: Pick<AccountView, 'external' | 'unverified'>): boolean {
  return account.external || account.unverified
}

export interface AccountOption {
  id: string
  /** The account's name alone. */
  name: string
  /** What the picker shows: the name plus "(Default)", "- confirm at launch"
   *  or "(Needs attention)". */
  label: string
  /** Blocked: listed so the user can see it, but not offered. */
  disabled: boolean
  isDefault: boolean
}

/**
 * The accounts a new session of a provider may be started on, as the picker
 * lists them: the provider default first, then the others by name, then the
 * blocked ones (shown, disabled, "Needs attention"). Inactive and archived
 * accounts are not listed: they are not offered for new work.
 */
export function sessionAccountOptions(snapshot: AccountsSnapshot | null, providerId: ProviderId): AccountOption[] {
  const active = (snapshot?.accounts ?? []).filter((a) => a.providerId === providerId && a.lifecycle === 'active')
  const options = active.map((a): AccountOption => {
    const name = accountDisplayName(snapshot, a)
    const blocked = a.operationalState === 'blocked'
    let label = launchNeedsAcknowledgement(a) ? `${name} - confirm at launch` : name
    if (a.isProviderDefault) label += ' (Default)'
    if (blocked) label += ' (Needs attention)'
    return { id: a.id, name, label, disabled: blocked, isDefault: a.isProviderDefault }
  })
  const byName = (x: AccountOption, y: AccountOption) => x.name.localeCompare(y.name)
  const rest = options.filter((o) => !o.isDefault)
  return [
    ...options.filter((o) => o.isDefault),
    ...rest.filter((o) => !o.disabled).sort(byName),
    ...rest.filter((o) => o.disabled).sort(byName),
  ]
}

/** The account a picker preselects: the provider default, when there is one. */
export function defaultAccountId(snapshot: AccountsSnapshot | null, providerId: ProviderId): string | undefined {
  return sessionAccountOptions(snapshot, providerId).find((o) => o.isDefault)?.id
}

/** The account's email for a confirmation line, when the provider reported
 *  one as its label. */
export function accountEmail(account: Pick<AccountView, 'providerLabel'> | undefined): string | undefined {
  const label = account?.providerLabel?.trim()
  return label && label.includes('@') ? label : undefined
}

export interface AccountFieldState {
  options: AccountOption[]
  /** The selected account when the list does not offer it: a saved config
   *  whose account has since been made inactive, archived or removed. */
  unlisted?: { id: string; label: string }
  selected?: AccountView
  /** The selected account launches only with a per-launch acknowledgement. */
  needsAck: boolean
  /** Something about the selected account the user has to act on first. */
  notice?: AccountNotice
}

/** What the picker shows for one selection. Nothing is judged before the
 *  snapshot has arrived: an id the app has not heard about yet is not
 *  "removed". */
export function accountFieldState(snapshot: AccountsSnapshot | null, providerId: ProviderId, selectedId: string | undefined): AccountFieldState {
  const options = sessionAccountOptions(snapshot, providerId)
  if (!snapshot || !selectedId) return { options, needsAck: false }
  const selected = snapshot.accounts.find((a) => a.id === selectedId && a.providerId === providerId)
  const listed = options.some((o) => o.id === selectedId)
  const unlisted = listed ? undefined : {
    id: selectedId,
    label: selected ? `${accountDisplayName(snapshot, selected)} (Needs attention)` : 'An account that was removed (Needs attention)',
  }
  let notice: AccountNotice | undefined
  if (!selected || selected.lifecycle !== 'active') notice = NEEDS_ATTENTION
  else if (selected.operationalState === 'blocked') notice = SIGNED_IN_ELSEWHERE
  return { options, unlisted, selected, needsAck: !!selected && launchNeedsAcknowledgement(selected), notice }
}

/** "Codex 0.150.2 is too old for this app..." for a CLI discovery found and
 *  judged too old. Main keeps the CLI it proved until it checks again, so
 *  updating alone does not reach a restarted session. "Check again" in
 *  Settings, Accounts (the Providers card) is that check: main's discovery
 *  replaces the executable its launches and sign-ins run. */
export function tooOldText(p: { displayName: string; version?: string }): string {
  const named = p.version ? `${p.displayName} ${p.version}` : p.displayName
  return `${named} is too old for this app. Update ${p.displayName}, then Check again in Settings, Accounts.`
}

/** The too-old sentence when discovery found a too-old CLI; null otherwise.
 *  The minimum version is not part of the snapshot, so it is not named. */
export function providerTooOldText(snapshot: AccountsSnapshot | null, providerId: ProviderId): string | null {
  const p = providerView(snapshot, providerId)
  if (!p || p.discoveryState !== 'found' || p.compatibility !== 'too-old') return null
  return tooOldText(p)
}

/** Why a provider that is on has no usable CLI (not found, did not run, or
 *  could not be checked), in the Providers card's own words; null when the
 *  CLI was found, is not checked yet, the provider is off, or there is no
 *  snapshot. Settings, Accounts shows the install commands and Check again. */
export function providerCliMissingText(snapshot: AccountsSnapshot | null, providerId: ProviderId): string | null {
  const p = providerView(snapshot, providerId)
  if (!p || !p.enabled) return null
  if (p.discoveryState !== 'missing' && p.discoveryState !== 'invalid' && p.discoveryState !== 'error') return null
  return providerStatus(p).text
}

export interface LaunchAccountPlan {
  /** The account id to send with the spawn; absent = let main use the
   *  provider default (today's behaviour). */
  accountId?: string
  /** This launch must be acknowledged, naming `accountId`. */
  needsAck: boolean
  account?: AccountView
  /** The account list could not be read, so whether the account needs an
   *  acknowledgement is not known: the launch asks anyway (main still
   *  validates the account). */
  unknown?: boolean
}

/**
 * The account a launch names. A session bound to an account names it. An
 * unbound session keeps today's behaviour (main picks the provider default)
 * UNLESS that default needs an acknowledgement: an acknowledgement counts
 * only with the id it names, so the launch then names the default it is
 * asking about -- never a flag that would consent to whatever the default
 * becomes later. With no account list at all, a bound session asks rather
 * than assume its account needs nothing.
 */
export function resolveLaunchAccount(snapshot: AccountsSnapshot | null, providerId: ProviderId, boundId: string | undefined): LaunchAccountPlan {
  if (boundId) {
    if (!snapshot) return { accountId: boundId, needsAck: true, unknown: true }
    const account = snapshot.accounts.find((a) => a.id === boundId && a.providerId === providerId)
    return { accountId: boundId, needsAck: !!account && launchNeedsAcknowledgement(account), account }
  }
  const def = snapshot?.accounts.find((a) => a.providerId === providerId && a.lifecycle === 'active' && a.isProviderDefault)
  if (def && launchNeedsAcknowledgement(def)) return { accountId: def.id, needsAck: true, account: def }
  return { needsAck: false }
}

/** The account fields a spawn sends. */
export interface LaunchAccountFields {
  providerAccountId?: string
  acknowledgeRealmOnly?: true
}

/** What the per-launch confirm asks about. */
export interface LaunchQuestion {
  accountName: string
  email?: string
  /** The provider's own home on this computer. */
  external: boolean
  /** The account list could not be read. */
  unknown: boolean
}

/** A launch's next step: spawn now with these fields, or ask first and spawn
 *  with them on a yes. */
export type LaunchStep =
  | { kind: 'spawn'; fields: LaunchAccountFields }
  | { kind: 'ask'; fields: LaunchAccountFields; question: LaunchQuestion }

/**
 * The step for a plan. `granted`: the New session dialog's tick covered this
 * launch, for exactly `plan.accountId` (the caller has used the grant up).
 */
export function launchStep(snapshot: AccountsSnapshot | null, plan: LaunchAccountPlan, granted: boolean): LaunchStep {
  const named: LaunchAccountFields = plan.accountId ? { providerAccountId: plan.accountId } : {}
  if (!plan.needsAck || !plan.accountId) return { kind: 'spawn', fields: named }
  const acknowledged: LaunchAccountFields = { ...named, acknowledgeRealmOnly: true }
  if (granted) return { kind: 'spawn', fields: acknowledged }
  return {
    kind: 'ask',
    fields: acknowledged,
    question: {
      accountName: plan.account ? accountDisplayName(snapshot, plan.account) : 'this Codex account',
      email: accountEmail(plan.account),
      external: !!plan.account?.external,
      unknown: !!plan.unknown,
    },
  }
}

/** The snapshot as soon as the first answer has arrived (a restored session
 *  can spawn before App's hydrate settles); after `timeoutMs` the launch goes
 *  on with whatever is known, and main still refuses what it must. */
export function accountsSnapshotWhenLoaded(timeoutMs = 5000): Promise<AccountsSnapshot | null> {
  const now = useProviderAccountsStore.getState()
  if (now.loaded) return Promise.resolve(now.snapshot)
  return new Promise((resolve) => {
    let done = false
    let unsub: () => void = () => {}
    const finish = () => {
      if (done) return
      done = true
      unsub()
      clearTimeout(timer)
      resolve(useProviderAccountsStore.getState().snapshot)
    }
    const timer = setTimeout(finish, timeoutMs)
    unsub = useProviderAccountsStore.subscribe((s) => { if (s.loaded) finish() })
  })
}

/** What the terminal knows when a spawn fails: the Codex CLI discovery found
 *  and the account the launch was for. */
export interface LaunchFailureContext {
  version?: string
  compatibility?: Compatibility
  /** The launch's account was this computer's own sign-in (true), a managed
   *  one (false), or is not known (absent). */
  external?: boolean
}

/**
 * A failed spawn as the terminal says it. Main refuses a Codex launch with
 * "Codex session refused: <reason>"; the reasons a user can act on are put in
 * plain words (design 13), and anything else keeps main's own text. Main
 * sends only the message across IPC, not the refusal code, so this matches
 * main's sentences (src/main/providers/core/accounts-service.ts,
 * src/shared/providers/registry.ts resolveLaunchBinding,
 * src/main/providers/codex/auth-operations.ts).
 */
export function describeLaunchFailure(err: unknown, ctx: LaunchFailureContext = {}): string {
  const text = formatSpawnError(err)
  const m = /^Codex session refused:\s*([\s\S]*)$/.exec(text)
  if (!m) return `Failed to launch session: ${text}`
  const why = m[1].trim()
  const said = (plain: string) => `Codex did not start. ${plain}`
  if (/confirm that this launch may use it|confirm to continue/i.test(why)) {
    if (ctx.external === true) return said('This launch was not confirmed for the Codex sign-in already on this computer. Restart the session to confirm it.')
    if (ctx.external === false) return said("This launch was not confirmed for this account's unverified sign-in. Restart the session to confirm it.")
    return said('This launch needs your confirmation. Restart the session to confirm it.')
  }
  if (/the account is (inactive|archived)|activate it or choose another|blocked until its sign-in is reconciled/i.test(why)) {
    return said(NEEDS_ATTENTION_TEXT)
  }
  if (/signing in again/i.test(why)) return said('This account is signing in again. Try again when that finishes.')
  if (/something else is using this account/i.test(why)) return said('This account is busy right now. Try again when it finishes.')
  if (/different sign-in than before|could not record it/i.test(why)) return said(SIGNED_IN_ELSEWHERE_TEXT)
  // Main says "cannot be used" for any CLI it may not run: too old, or not
  // proven (discovery had no answer). Only the first is "too old".
  if (/version cannot be used/i.test(why)) {
    if (ctx.compatibility === 'too-old') return said(tooOldText({ displayName: 'Codex', version: ctx.version }))
    if (ctx.compatibility === 'unsupported') return said('This Codex is not one this app supports. Update Codex, then restart the app.')
    return said(noticeText(NOT_CHECKED))
  }
  if (/no longer exists/i.test(why)) return said('The account this session uses no longer exists. Edit the config to choose another account.')
  // An unbound session, and no account of the provider at all
  // (chooseSessionAccount in src/shared/providers/registry.ts).
  if (/no account of this provider is set up/i.test(why)) return said(noticeText(NO_ACCOUNT))
  return said(why)
}
