import React from 'react'
import { useSessionStore, type Session } from '../stores/sessionStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useResolvedTheme } from '../hooks/useThemeController'
import {
  resolveAccountNameByEmail,
  resolveAccountColourKey,
  canonicaliseEmail,
} from '../../shared/account-chip-color'
import { resolveIdentityColor, type IdentityColorKey } from '../../shared/identity-colors'
import RateLimitBar, { RateLimitBarPending, RateLimitBarNoReading } from './terminal/RateLimitBar'
import type { AccountProfile } from '../../shared/account-types'
import type { UsageBucket } from '../../shared/usage-types'
import type { AccountsSnapshot, AccountView, IdentityView, ProviderId } from '../../shared/providers'
import { bucketPastReset } from '../../shared/usage-labels'
import { formatResetTime } from '../utils/terminalFormatting'
import {
  useProviderAccountsStore, accountForLegacyId, accountDisplayName, providerView, signInMethodLabel, ACCOUNT_NAME_FALLBACK,
} from '../stores/providerAccountsStore'
import { usesCodex } from '../onboarding/provider-choice'
import { useRenderAtNextReset } from '../hooks/useRenderAtNextReset'
import { ProviderMark } from './sidebar/Badges'

// Stable empty ref so the Zustand selector for an absent denylist doesn't spin a
// fresh array each render (re-render cascade guard).
const EMPTY_HIDDEN: string[] = []

export interface LiveAccount {
  email: string
  name: string
  colourKey: IdentityColorKey
  /** Worst-case (max %) usage bucket per label across this account's live
   *  sessions -- the dynamic set (5h, Weekly, Fable, future per-model), with a
   *  legacy 5h/Weekly synthesis for older CLIs that predate usageBuckets.
   *  First-seen order (≈ the API's 5h, Weekly, then per-model). */
  buckets: UsageBucket[]
  count: number
  isPrimary: boolean
}

/**
 * The usage buckets a single session contributes: the dynamic `usageBuckets`
 * when the CLI reports them, else a legacy synthesis from the old
 * rateLimitCurrent/Weekly fields so pre-usageBuckets sessions still show 5h/Weekly.
 */
function sessionUsageBuckets(s: Session): UsageBucket[] {
  if (s.usageBuckets && s.usageBuckets.length > 0) return s.usageBuckets
  const out: UsageBucket[] = []
  if (typeof s.rateLimitCurrent === 'number') {
    out.push({ key: '5h', label: '5h', group: 'session', percent: s.rateLimitCurrent, resetsAt: s.rateLimitCurrentResets ?? '', severity: 'normal' })
  }
  if (typeof s.rateLimitWeekly === 'number') {
    out.push({ key: 'weekly', label: 'Weekly', group: 'weekly', percent: s.rateLimitWeekly, resetsAt: s.rateLimitWeeklyResets ?? '', severity: 'normal' })
  }
  return out
}

/** The dash the footer's tooltips and labels join their parts with. */
const DASH = String.fromCharCode(0x2014)
/** The dot the tooltips list readings with. */
const MIDDOT = String.fromCharCode(0xb7)

/**
 * How each provider's sessions sit in the footer (usage track MP5; Q1.2 of
 * the approved usage UX). Keyed by provider id, so the footer decides by this
 * data and never by a provider's name.
 *   - `byEmail`: its sessions are attributed by the account email their status
 *     line reports (and an SSH session by the remote one, #571), then to that
 *     account's identity; otherwise by the registry account the session runs
 *     under, else the provider default.
 *   - `plainAlone`: a pill of this provider alone reads as it always has: the
 *     email with meters, the name with dots, its name and colour from the
 *     email (aliases and colour overrides), and no provider mark.
 *   - `bareHidden`: the footer's hidden entries written as a bare label are
 *     its own (they predate other providers' groups).
 *   - `words`: when nothing will ever report, its group says so in one word
 *     (D3) instead of a placeholder.
 */
interface FooterProviderRules { byEmail: boolean; plainAlone: boolean; bareHidden: boolean; words: boolean }
/** Claude Code: attributed by the email its status line reports. */
const EMAIL_ATTRIBUTED: FooterProviderRules = { byEmail: true, plainAlone: true, bareHidden: true, words: false }
/** Codex: attributed by the registry account its session runs under. */
const ACCOUNT_ATTRIBUTED: FooterProviderRules = { byEmail: false, plainAlone: false, bareHidden: false, words: true }
const FOOTER_PROVIDER: Readonly<Record<ProviderId, FooterProviderRules>> = { claude: EMAIL_ATTRIBUTED, codex: ACCOUNT_ATTRIBUTED }
const PROVIDER_ORDER = Object.keys(FOOTER_PROVIDER) as ProviderId[]
const DEFAULT_PROVIDER: ProviderId = PROVIDER_ORDER[0]
const PROVIDER_NAME: Readonly<Record<ProviderId, string>> = { claude: 'Claude Code', codex: 'Codex' }

/** D3: why a provider's group will never show a meter. */
export type UsageGroupWord = 'per token' | 'no reading'

/** What a D3 word means, for its tooltip. */
export const USAGE_WORD_TIP: Readonly<Record<UsageGroupWord, string>> = {
  'per token': 'Billed per token, so there is no plan allowance.',
  'no reading': 'No reading from this session.',
}

/** One provider's meters in an identity's pill. */
export interface LiveUsageGroup {
  providerId: ProviderId
  /** Worst-case (max %) bucket per label across the identity's live sessions
   *  of this provider, in first-seen order. Never mixed with another
   *  provider's: percentages are not comparable across providers. */
  buckets: UsageBucket[]
  /** D3: nothing will ever report for it. */
  word?: UsageGroupWord
  /** The account email its sessions report (the providers attributed by it). */
  email?: string
  /** How its account signs in ("ChatGPT sign-in", "API key"), for the tooltip. */
  method?: string
}

/** One pill: an identity (a person), with a group per provider it has live
 *  sessions of. */
export interface LiveIdentity {
  /** The registry identity's id, or the canonical email when the registry
   *  cannot name one (it is unavailable, or the email has no profile). */
  key: string
  name: string
  /** The email a plain pill shows with meters. */
  email?: string
  colourKey: IdentityColorKey
  /** Live sessions, every provider. */
  count: number
  isPrimary: boolean
  groups: LiveUsageGroup[]
  /** One group of a provider whose pill alone reads as it always has. */
  plain: boolean
}

function identityOf(snapshot: AccountsSnapshot | null, account: AccountView | undefined): IdentityView | undefined {
  if (!account) return undefined
  return snapshot?.identities.find((i) => i.id === account.identityId)
}

/**
 * Aggregate the live (running) sessions into one entry per IDENTITY, each with
 * a group per provider (usage track MP5, Q1.2): a person with a Claude Code
 * and a Codex account linked to one identity is one pill, the two meter groups
 * side by side, never merged.
 *
 * "Running" = any session still open (excludes `disconnected`). A session of a
 * provider attributed by email (Claude Code) is grouped by the email its
 * status line reports: its local account first, else the remote signed-in
 * email of an SSH session (`sshRemoteAccount`, display-only; #571: without it
 * an SSH session showed neither its account's name nor its per-model buckets),
 * then through that email's profile to the registry identity. Without one (no
 * registry, or no profile for the email) it is keyed by the email, exactly as
 * before. A session with no email is skipped, as before. A session of any
 * other provider (Codex) is grouped by the registry account it runs under,
 * else that provider's default account; with neither, it is skipped.
 *
 * Per provider, per bucket label, the WORST-CASE (max) utilisation, so the
 * number is never falsely low when one session has a stale tick. A pill that
 * holds only Claude Code sessions reads as it always has (name and colour
 * from the email, aliases and overrides included); a linked or Codex pill
 * takes the identity's name and colour. Ordered primary-first, then by name.
 * Pure + unit-tested; the component gates on >=2. Presentation grouping only:
 * nothing here grants account authority.
 */
export function liveIdentityUsage(
  sessions: Session[],
  profiles: AccountProfile[],
  aliases: Record<string, string> | undefined,
  colourOverrides: Record<string, IdentityColorKey> | undefined,
  snapshot: AccountsSnapshot | null,
): LiveIdentity[] {
  const primaryEmail = profiles.find((p) => p.isPrimary)?.accountEmail
  const primaryCanon = primaryEmail ? canonicaliseEmail(primaryEmail) : undefined
  interface GroupAcc { group: LiveUsageGroup; labels: Map<string, UsageBucket>; sessions: number; unavailable: number; perToken: boolean }
  interface Acc {
    key: string
    identity?: IdentityView
    /** The first account seen that is not attributed by email (its name is
     *  the fallback for a pill with no identity name and no email). */
    account?: AccountView
    email?: string
    accountColour?: IdentityColorKey
    count: number
    isPrimary: boolean
    groups: Map<ProviderId, GroupAcc>
  }
  const byKey = new Map<string, Acc>()

  for (const s of sessions) {
    if (s.status === 'disconnected') continue
    const providerId: ProviderId = s.provider ?? DEFAULT_PROVIDER
    const how = FOOTER_PROVIDER[providerId]
    if (!how) continue
    let key: string
    let account: AccountView | undefined
    let identity: IdentityView | undefined
    let email: string | undefined
    if (how.byEmail) {
      email = s.accountEmail || s.sshRemoteAccount
      if (!email) continue
      const canon = canonicaliseEmail(email)
      const profile =
        profiles.find((p) => !!p.accountEmail && canonicaliseEmail(p.accountEmail) === canon) ??
        (s.profileId ? profiles.find((p) => p.id === s.profileId) : undefined)
      account = profile ? accountForLegacyId(snapshot, providerId, profile.id) : undefined
      identity = identityOf(snapshot, account)
      key = identity ? `identity:${identity.id}` : `email:${canon}`
    } else {
      account = s.providerAccountId
        ? snapshot?.accounts.find((a) => a.id === s.providerAccountId && a.providerId === providerId)
        : snapshot?.accounts.find((a) => a.providerId === providerId && a.isProviderDefault && a.lifecycle !== 'archived')
      identity = identityOf(snapshot, account)
      if (!account || !identity) continue
      key = `identity:${identity.id}`
    }
    let acc = byKey.get(key)
    if (!acc) {
      acc = { key, identity, count: 0, isPrimary: false, groups: new Map() }
      byKey.set(key, acc)
    }
    acc.count++
    if (email && acc.email === undefined) {
      acc.email = email
      acc.accountColour = s.accountColour
    }
    if (email && primaryCanon === canonicaliseEmail(email)) acc.isPrimary = true
    if (!how.byEmail && !acc.account) acc.account = account
    let g = acc.groups.get(providerId)
    if (!g) {
      const provider = providerView(snapshot, providerId) ?? { providerId, displayName: PROVIDER_NAME[providerId] }
      const method = !how.byEmail && account && !account.external ? signInMethodLabel(account, provider) : null
      g = {
        group: { providerId, buckets: [], ...(email ? { email } : {}), ...(method ? { method } : {}) },
        labels: new Map(),
        sessions: 0,
        unavailable: 0,
        perToken: account?.authMethod === 'apiKey',
      }
      acc.groups.set(providerId, g)
    }
    g.sessions++
    if (s.usageUnavailable === 'no-reading') g.unavailable++
    for (const b of sessionUsageBuckets(s)) {
      const prev = g.labels.get(b.label)
      if (!prev || b.percent > prev.percent) g.labels.set(b.label, b)
    }
  }

  const out: LiveIdentity[] = []
  for (const acc of byKey.values()) {
    const groups: LiveUsageGroup[] = []
    for (const providerId of PROVIDER_ORDER) {
      const g = acc.groups.get(providerId)
      if (!g) continue
      const group: LiveUsageGroup = { ...g.group, buckets: Array.from(g.labels.values()) }
      if (FOOTER_PROVIDER[providerId].words && group.buckets.length === 0) {
        if (g.perToken) group.word = 'per token'
        else if (g.unavailable === g.sessions) group.word = 'no reading'
      }
      groups.push(group)
    }
    const plain = groups.length === 1 && FOOTER_PROVIDER[groups[0].providerId].plainAlone && !!acc.email
    const name = plain
      ? resolveAccountNameByEmail(acc.email as string, profiles, aliases)
      : acc.identity?.friendlyName?.trim() || acc.email || (acc.account ? accountDisplayName(snapshot, acc.account) : ACCOUNT_NAME_FALLBACK)
    const colourKey = !plain && acc.identity
      ? (acc.identity.colourKey as IdentityColorKey)
      : resolveAccountColourKey(acc.email, colourOverrides, acc.accountColour)
    out.push({ key: acc.key, name, ...(acc.email ? { email: acc.email } : {}), colourKey, count: acc.count, isPrimary: acc.isPrimary, groups, plain })
  }
  return out.sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

/**
 * The accounts of the email-attributed provider (Claude Code) as the footer
 * had them before identities: one entry per distinct email. What
 * liveIdentityUsage gives with no registry, in the older shape.
 */
export function liveAccountUsage(
  sessions: Session[],
  profiles: AccountProfile[],
  aliases: Record<string, string> | undefined,
  colourOverrides: Record<string, IdentityColorKey> | undefined,
): LiveAccount[] {
  return liveIdentityUsage(sessions, profiles, aliases, colourOverrides, null).map((i) => ({
    email: i.email ?? i.name,
    name: i.name,
    colourKey: i.colourKey,
    buckets: i.groups[0]?.buckets ?? [],
    count: i.count,
    isPrimary: i.isPrimary,
  }))
}

/** The footer grows to at most two rows; past that the tail goes behind the
 *  "+N" overflow control rather than eating more of the terminal's height. */
export const FOOTER_MAX_ROWS = 2
/** Horizontal gap between pills, in px. Applied as an INLINE style (not a
 *  Tailwind `gap-x-*` class) so the number the layout is computed with and the
 *  number the browser lays out with are the same one -- rem-based utilities
 *  scale with the global UI font size, a px constant does not. */
export const FOOTER_PILL_GAP_PX = 12
/** Room held back on the last row for the "+N" control when anything
 *  overflows, so the control never pushes the row past the zone. Generous for
 *  a two-digit count at 10px text; the popover itself is position: fixed. */
export const FOOTER_OVERFLOW_RESERVE_PX = 40
/** Sub-pixel slack on the fit test: getBoundingClientRect() returns fractional
 *  widths and a pill that is 0.3px "too wide" still paints on the row. */
const FIT_EPSILON_PX = 0.5

export interface FooterRowLayout<T> {
  /** Rendered rows, in order, each filled before the next starts. */
  rows: T[][]
  /** Everything that does not fit in FOOTER_MAX_ROWS rows -- shown via the
   *  "+N" overflow control on the last row. */
  overflow: T[]
}

export interface FooterLayoutOptions {
  /** Free width of the footer's centre zone, in px. <= 0 means "not measured
   *  yet" and yields one row of everything (CSS flex-wrap then wraps it). */
  available: number
  gap?: number
  maxRows?: number
  overflowReserve?: number
}

/**
 * Lay the account pills out in rows by MEASURED width (#378).
 *
 * The previous split was by count (<=3 one row, 4..6 two rows balanced 2+2 /
 * 3+2 / 3+3, >6 overflow) and so put four accounts on two rows at 1900px with
 * empty footer either side of them. This one answers the owner's actual rule:
 * one row whenever everything fits in the free width; wrap only when it truly
 * does not, filling each row before starting the next; never more than
 * FOOTER_MAX_ROWS rows, the rest behind "+N".
 *
 *   - `widths[i]` is item i's measured width. An item with no measurement yet
 *     (never painted -- e.g. it appeared straight into the overflow) is
 *     estimated at the WIDEST measured pill, which errs towards wrapping
 *     earlier rather than spilling out of the zone; it is corrected the first
 *     time the pill is painted and measured.
 *   - With no `available` width, or no measurement at all, the answer is a
 *     single row: the first frame before the layout effect has run, and jsdom.
 *   - A pill wider than the whole zone sits alone on a row (it can ellipsise).
 *   - When anything overflows, the last row keeps `overflowReserve` px free for
 *     the control, moving pills into the overflow until it fits.
 *
 * Pure and generic so the fit boundaries are unit-testable without a DOM.
 */
export function layoutFooterRows<T>(
  items: T[],
  widths: ReadonlyArray<number | undefined>,
  opts: FooterLayoutOptions,
): FooterRowLayout<T> {
  if (items.length === 0) return { rows: [], overflow: [] }
  const gap = opts.gap ?? FOOTER_PILL_GAP_PX
  const maxRows = Math.max(1, opts.maxRows ?? FOOTER_MAX_ROWS)
  const reserve = opts.overflowReserve ?? FOOTER_OVERFLOW_RESERVE_PX
  const available = opts.available
  const isWidth = (w: number | undefined): w is number => typeof w === 'number' && Number.isFinite(w) && w > 0
  const measured = widths.filter(isWidth)
  if (!(available > 0) || measured.length === 0) return { rows: [items], overflow: [] }
  const estimate = Math.max(...measured)
  const widthOf = (i: number): number => {
    const w = widths[i]
    return isWidth(w) ? w : estimate
  }
  const fits = (w: number) => w <= available + FIT_EPSILON_PX

  const rows: T[][] = []
  let cur: T[] = []
  let curW = 0
  let overflowFrom = -1
  for (let i = 0; i < items.length; i++) {
    const w = widthOf(i)
    if (cur.length > 0 && !fits(curW + gap + w)) {
      if (rows.length === maxRows - 1) {
        overflowFrom = i
        break
      }
      rows.push(cur)
      cur = []
      curW = 0
    }
    cur.push(items[i])
    curW = cur.length === 1 ? w : curW + gap + w
  }
  if (cur.length > 0) rows.push(cur)
  const overflow = overflowFrom >= 0 ? items.slice(overflowFrom) : []

  // The "+N" control lives on the last row: make room for it, pulling pills
  // into the overflow from the end until it fits (never emptying the row).
  if (overflow.length > 0) {
    const last = rows[rows.length - 1]
    const lastStart = items.length - overflow.length - last.length
    let lastW = curW
    while (last.length > 1 && !fits(lastW + gap + reserve)) {
      overflow.unshift(last.pop() as T)
      lastW -= gap + widthOf(lastStart + last.length)
    }
  }
  return { rows, overflow }
}

/** Measured geometry the row layout is computed from: the centre zone's free
 *  width and each painted pill's width, keyed by account. */
interface FooterMetrics {
  available: number
  widths: Record<string, number>
}

const EMPTY_METRICS: FooterMetrics = { available: 0, widths: {} }

/**
 * Fold a fresh measurement into the previous one. Returns `prev` itself when
 * nothing moved by more than the fit epsilon, so the state update is a no-op
 * and the measure -> set -> render -> measure cycle terminates. Keys no longer
 * live are dropped; keys live but not currently painted (behind "+N") keep
 * their last measurement.
 */
export function reconcileFooterMetrics(
  prev: FooterMetrics,
  available: number,
  fresh: Record<string, number>,
  liveKeys: ReadonlySet<string>,
): FooterMetrics {
  let changed = Math.abs(prev.available - available) > FIT_EPSILON_PX
  const widths: Record<string, number> = {}
  for (const k of liveKeys) {
    const w = fresh[k] ?? prev.widths[k]
    if (w === undefined) continue
    widths[k] = w
    const before = prev.widths[k]
    if (before === undefined || Math.abs(before - w) > FIT_EPSILON_PX) changed = true
  }
  for (const k of Object.keys(prev.widths)) if (!liveKeys.has(k)) changed = true
  return changed ? { available, widths } : prev
}

/**
 * Rows for the footer from REAL widths. Measures the strip's free width and
 * every painted pill synchronously in a layout effect when the set of accounts
 * or what the pills show changes (so the first paint is already laid out), and
 * via a ResizeObserver on the strip and the pills for everything else --
 * window resize, font scale, a meter appearing. Widths are cached by account
 * so a pill currently behind the "+N" control keeps the width it had when it
 * was last painted.
 */
function useMeasuredFooterRows(
  accounts: LiveIdentity[],
  contentSignature: string,
): {
  layout: FooterRowLayout<LiveIdentity>
  rootRef: React.RefObject<HTMLDivElement | null>
  pillRef: (key: string) => (el: HTMLElement | null) => void
} {
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const pillEls = React.useRef(new Map<string, HTMLElement>())
  const [metrics, setMetrics] = React.useState<FooterMetrics>(EMPTY_METRICS)
  const liveKeys = React.useMemo(() => new Set(accounts.map((a) => a.key)), [accounts])
  const liveKeysRef = React.useRef(liveKeys)
  liveKeysRef.current = liveKeys

  const measure = React.useCallback(() => {
    const root = rootRef.current
    if (!root) return
    const available = root.getBoundingClientRect().width
    const fresh: Record<string, number> = {}
    for (const [k, el] of pillEls.current) fresh[k] = el.getBoundingClientRect().width
    setMetrics((prev) => reconcileFooterMetrics(prev, available, fresh, liveKeysRef.current))
  }, [])

  // Callback refs keep a live key -> element map without a querySelectorAll
  // sweep per render. One stable function per key, so React does not detach
  // and re-attach every pill on every render.
  const refCache = React.useRef(new Map<string, (el: HTMLElement | null) => void>())
  const pillRef = React.useCallback((key: string) => {
    let fn = refCache.current.get(key)
    if (!fn) {
      fn = (el) => {
        if (el) pillEls.current.set(key, el)
        else pillEls.current.delete(key)
      }
      refCache.current.set(key, fn)
    }
    return fn
  }, [])

  const layout = React.useMemo(
    () => layoutFooterRows(accounts, accounts.map((a) => metrics.widths[a.key]), { available: metrics.available }),
    [accounts, metrics],
  )

  // Re-run when the set of accounts, what a pill shows, or the row assignment
  // changes: each can mount/unmount pill ELEMENTS (a pill that moves to another
  // row is a new node under a new parent) that the observer must (un)watch.
  // Bounded: a re-measure that changes nothing returns the same metrics object,
  // so no re-render follows and the cycle ends.
  const keysSignature = accounts.map((a) => a.key).join(' ')
  const rowsSignature = layout.rows.map((r) => r.length).join('/') + ':' + layout.overflow.length
  React.useLayoutEffect(() => {
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    if (rootRef.current) ro.observe(rootRef.current)
    for (const el of pillEls.current.values()) ro.observe(el)
    return () => ro.disconnect()
  }, [measure, keysSignature, contentSignature, rowsSignature])

  return { layout, rootRef, pillRef }
}

function providerNameOf(providerId: ProviderId, snapshot: AccountsSnapshot | null): string {
  return providerView(snapshot, providerId)?.displayName ?? PROVIDER_NAME[providerId]
}

/** A reset time as the tooltips say it ("reset 3:10 pm, no reading since"). */
function pastLine(b: UsageBucket): string {
  return `${b.label} ${DASH} reset ${formatResetTime(b.resetsAt)}, no reading since`
}

function tooltip(
  a: LiveIdentity,
  snapshot: AccountsSnapshot | null,
  now: number,
  opts?: { withPercent?: boolean; showPending?: boolean },
): string {
  const lines = [`${a.name} ${DASH} ${a.count} live session${a.count === 1 ? '' : 's'}`]
  for (const g of a.groups) {
    if (a.plain) {
      // The email can be ellipsised in the two-row layout, so keep it in the
      // tooltip -- the account is otherwise unidentifiable when it is clipped.
      if (a.email && a.name !== a.email) lines.push(a.email)
    } else {
      const sub = g.email ?? g.method
      lines.push(`${providerNameOf(g.providerId, snapshot)}${sub ? ` ${MIDDOT} ${sub}` : ''}`)
      if (g.word) { lines.push(USAGE_WORD_TIP[g.word]); continue }
    }
    // Usage track MP6 (as drawn): a pill still waiting for its first reading
    // says so, a plain one too.
    if (g.buckets.length === 0 && opts?.showPending) { lines.push('Waiting for the status line'); continue }
    for (const b of g.buckets) {
      if (bucketPastReset(b, now)) { lines.push(pastLine(b)); continue }
      // In minimal mode the dots carry a BAND, not a figure, so the exact number
      // has nowhere else to live and the tooltip is the whole readout rather than
      // a supplement to a visible bar.
      const parts = [b.label]
      if (opts?.withPercent) parts.push(`${Math.round(b.percent)}%`)
      if (b.resetsAt) parts.push(`resets ${b.resetsAt}`)
      if (parts.length > 1) lines.push(parts.join(` ${DASH} `))
    }
  }
  return lines.join('\n')
}

/** The labels hidden from a provider's group: its own `<provider>:<label>`
 *  entries, and the bare-label entries of the provider they belong to. */
function hiddenFor(providerId: ProviderId, hidden: string[]): string[] {
  const out: string[] = []
  for (const h of hidden) {
    const i = h.indexOf(':')
    const scope = i > 0 ? h.slice(0, i) : ''
    if (scope && Object.hasOwn(FOOTER_PROVIDER, scope)) { if (scope === providerId) out.push(h.slice(i + 1)) }
    else if (FOOTER_PROVIDER[providerId].bareHidden) out.push(h)
  }
  return out
}

function shownBuckets(a: { buckets: UsageBucket[] }, hidden: string[]): UsageBucket[] {
  return a.buckets.filter((b) => !hidden.includes(b.label))
}

/**
 * Whether a bucket is a PER-MODEL weekly (Fable, and whatever follows it) as
 * opposed to a time window (5h, Weekly-all).
 *
 * Group alone cannot decide this: `usage-buckets.ts` gives a per-model weekly
 * `group: 'weekly'`, the same as weekly-all. What it does do is encode the model
 * into the key as `<kind>:<model display name>`, leaving that segment empty for
 * the time windows -- so the key is the producer's own answer to the question.
 * The legacy synthesis in this file uses bare keys with no colon at all, which
 * lands on "not a model bucket", which is right.
 */
export function isModelBucket(b: UsageBucket): boolean {
  const i = b.key.indexOf(':')
  return i >= 0 && b.key.slice(i + 1).trim() !== ''
}

export type RagState = 'green' | 'amber' | 'red'

/**
 * Traffic-light state for a utilisation percentage.
 *
 * These are the boundaries RateLimitBar already paints at -- its fill turns
 * peach at 70 and red at 90 -- deliberately, so a dot can never disagree with
 * the bar the user sees when they switch the setting back, and so there is no
 * second set of thresholds to keep in step.
 */
export function ragFor(percent: number): RagState {
  if (percent >= 90) return 'red'
  if (percent >= 70) return 'amber'
  return 'green'
}

export interface AccountDotSummary {
  /** Worst of the time-window buckets, plus the windows that fed it. Null when
   *  the account has no time-window bucket to show (all hidden, or none yet). */
  usage: { worst: UsageBucket; windows: UsageBucket[] } | null
  /** One entry per per-model bucket, in the API's order. Usually just Fable. */
  models: UsageBucket[]
}

/**
 * Minimal mode's counterpart to RateLimitBarPending: an account whose statusline
 * has not reported yet. Neutral and hollow, in none of the three traffic-light
 * hues, because any of them would be a claim about usage nobody has measured.
 */
function PendingDot() {
  return (
    <span
      role="img"
      aria-label="waiting for the status line"
      title="Waiting for the status line"
      data-testid="account-usage-dot-pending"
      className="statusline-pending-track"
      style={{
        width: 9,
        height: 9,
        borderRadius: 999,
        border: '1.5px dashed var(--text-muted)',
        background: 'transparent',
        flex: 'none',
        display: 'inline-block',
      }}
    />
  )
}

/**
 * Reduce an account's buckets to what minimal mode draws: one dot for usage and
 * one per model. "Usage" is the WORST of the time windows rather than an
 * average -- the question the strip answers is "is anything about to run out",
 * and averaging 5h 10% with Weekly 95% would answer it wrongly.
 *
 * Honours the same footer denylist as the meters, so hiding Fable drops its dot
 * and hiding Weekly leaves the usage dot tracking 5h alone. Pure + tested.
 */
export function summariseAccountDots(a: { buckets: UsageBucket[] }, hidden: string[]): AccountDotSummary {
  const shown = shownBuckets(a, hidden)
  const models = shown.filter(isModelBucket)
  const windows = shown.filter((b) => !isModelBucket(b))
  const worst = windows.reduce<UsageBucket | null>(
    (acc, b) => (!acc || b.percent > acc.percent ? b : acc),
    null,
  )
  return { usage: worst ? { worst, windows } : null, models }
}

const RAG_TOKEN: Record<RagState, string> = {
  green: 'var(--color-green)',
  amber: 'var(--color-yellow)',
  red: 'var(--color-red)',
}

const RAG_WORD: Record<RagState, string> = {
  green: 'fine',
  amber: 'running low',
  red: 'nearly exhausted',
}

/**
 * One traffic-light dot.
 *
 * Shape carries the state as well as hue -- hollow ring, half-filled, solid with
 * a halo -- because the pill's own tint is the ACCOUNT IDENTITY. A state told in
 * colour alone would be a second colour language inside the same nine pixels,
 * and would be unreadable to anyone who cannot separate the two hues.
 */
function UsageDot({ rag, title, label }: { rag: RagState; title: string; label: string }) {
  const c = RAG_TOKEN[rag]
  const base: React.CSSProperties = {
    width: 9,
    height: 9,
    borderRadius: 999,
    border: `1.5px solid ${c}`,
    flex: 'none',
  }
  const shape: React.CSSProperties =
    rag === 'green'
      ? { background: 'transparent' }
      : rag === 'amber'
        ? { backgroundColor: 'transparent', backgroundImage: `linear-gradient(180deg, transparent 0 50%, ${c} 50% 100%)` }
        : { background: c, boxShadow: `0 0 0 2.5px color-mix(in srgb, ${c} 22%, transparent)` }
  return (
    <span
      role="img"
      aria-label={label}
      title={title}
      data-testid="account-usage-dot"
      data-rag={rag}
      style={{ ...base, ...shape, display: 'inline-block' }}
    />
  )
}

/**
 * Placeholder meters for an account whose statusline has not reported yet.
 * These two always exist once a payload lands (model buckets like Fable are
 * discovered from the API and cannot be predicted), so showing exactly these
 * keeps the pill close to its eventual width without inventing a bucket that
 * may never appear.
 */
export const PENDING_FOOTER_LABELS = ['5h', 'Weekly']

/**
 * D2 in minimal mode: a window with no reading since its reset. The pending
 * dot's hollow dashed ring without its shimmer: nothing is known to be on
 * its way, and none of the three traffic-light hues, since any would be a
 * claim about usage nobody has measured.
 */
function NoReadingDot({ title }: { title: string }) {
  return (
    <span
      role="img"
      aria-label="no reading since its reset"
      title={title}
      data-testid="account-usage-dot-no-reading"
      style={{
        width: 9,
        height: 9,
        borderRadius: 999,
        border: '1.5px dashed var(--text-muted)',
        background: 'transparent',
        flex: 'none',
        display: 'inline-block',
      }}
    />
  )
}

/**
 * What one provider's group shows, or null for nothing: its meters (bars, or
 * dots in minimal mode unless `full`), a static no-reading meter for a window
 * past its reset (D2), its one word when nothing will ever report (D3), or a
 * placeholder while a first reading is still expected.
 */
function groupContent(
  g: LiveUsageGroup,
  opts: { hidden: string[]; minimal: boolean; showPending: boolean; now: number; full: boolean },
): React.ReactNode {
  const hidden = hiddenFor(g.providerId, opts.hidden)
  const compact = !opts.full
  const dots = opts.minimal && !opts.full
  if (g.buckets.length === 0) {
    if (g.word) {
      return (
        <span className="whitespace-nowrap" style={{ color: 'var(--text-muted)' }} title={USAGE_WORD_TIP[g.word]} data-testid="multi-account-word">
          {g.word}
        </span>
      )
    }
    // The account is live but its status line has not reported yet. An
    // account with no meters at all reads as an account with no usage, which
    // is the opposite of the truth on a fresh session.
    //
    // Only when a payload is actually coming: the status line must be on.
    // With the switch off nothing will ever replace the shimmer -- and one
    // that never resolves is worse than blank.
    if (!opts.showPending) return null
    // One neutral placeholder, NOT a green dot. Green is a claim that the
    // account has room; nothing has been reported, so the honest signal is
    // "waiting" -- same reasoning as the pending meter, which shows no colour
    // and no number until there is one.
    if (dots) return <PendingDot />
    const labels = PENDING_FOOTER_LABELS.filter((l) => !hidden.includes(l))
    return labels.length ? labels.map((l) => <RateLimitBarPending key={l} label={l} compact={compact} />) : null
  }
  // Nothing to show because the user hid every bucket for the footer: their
  // choice, so nothing, never a placeholder.
  const shown = shownBuckets(g, hidden)
  if (shown.length === 0) return null
  const past = (b: UsageBucket) => bucketPastReset(b, opts.now)
  if (dots) {
    // Usage first, then a dot per model, matching the order the meters were in.
    // B1: bare dots, no keys -- the labelled variant was measured wider than
    // the meters saved and cost minimal mode its single row.
    const summary = summariseAccountDots({ buckets: shown.filter((b) => !past(b)) }, [])
    const pastWindows = shown.filter((b) => past(b) && !isModelBucket(b))
    return (
      <>
        {summary.usage ? (
          <UsageDot
            rag={ragFor(summary.usage.worst.percent)}
            title={summary.usage.windows.map((b) => `${b.label} ${Math.round(b.percent)}%`).join(` ${MIDDOT} `)}
            label={`Usage ${RAG_WORD[ragFor(summary.usage.worst.percent)]} ${DASH} worst is ${summary.usage.worst.label} at ${Math.round(summary.usage.worst.percent)}%`}
          />
        ) : pastWindows.length > 0 ? (
          <NoReadingDot title={pastWindows.map(pastLine).join(` ${MIDDOT} `)} />
        ) : null}
        {shown.filter(isModelBucket).map((b) =>
          past(b) ? (
            <NoReadingDot key={b.key} title={pastLine(b)} />
          ) : (
            <UsageDot
              key={b.key}
              rag={ragFor(b.percent)}
              title={`${b.label} ${Math.round(b.percent)}%`}
              label={`${b.label} ${RAG_WORD[ragFor(b.percent)]} at ${Math.round(b.percent)}%`}
            />
          ),
        )}
      </>
    )
  }
  return shown.map((b) =>
    past(b)
      ? <RateLimitBarNoReading key={b.key} label={b.label} resetsAt={b.resetsAt} compact={compact} />
      : <RateLimitBar key={b.key} label={b.label} pct={b.percent} resets={b.resetsAt || undefined} compact={compact} />,
  )
}

/** Whether a group is led by its provider's mark: in a linked identity's pill
 *  (so the two groups are told apart), or when its provider's pill never
 *  reads plain (a Codex group, even alone). */
function groupMarked(a: LiveIdentity, g: LiveUsageGroup): boolean {
  return a.groups.length > 1 || !FOOTER_PROVIDER[g.providerId].plainAlone
}

/**
 * One identity: its label + a group of meters per provider. `compact` is the
 * two-row layout -- the pill may shrink and the label ellipsises (tooltip keeps
 * it), so three pills survive a narrow window. Single-row keeps `shrink-0` +
 * the full label, i.e. exactly the pre-two-row rendering. A plain pill (one
 * Claude Code account) renders as it always has: its email with meters, its
 * name with dots, and no mark.
 */
function IdentityPill({
  identity,
  hidden,
  theme,
  compact,
  showPending,
  minimal,
  now,
  snapshot,
  pillRef,
}: {
  identity: LiveIdentity
  hidden: string[]
  theme: 'dark' | 'light'
  compact: boolean
  /** Measurement hook-up: the row layout is computed from this element's
   *  rendered width (#378). */
  pillRef?: (el: HTMLElement | null) => void
  /** Whether a payload is still expected -- see the gate in the parent. */
  showPending: boolean
  /** Minimal mode: the meters collapse to traffic-light dots and a plain pill's
   *  label becomes the account's NAME, which is the friendly name when one is
   *  set and the full email when it is not. */
  minimal: boolean
  now: number
  snapshot: AccountsSnapshot | null
}) {
  // The pill is tinted with the identity's OWN colour, so the rim ties the
  // row to the person instead of drawing a neutral box around it. No dot
  // (user call 2026-08-21): the rim, the fill and a dot were three statements
  // of one fact. The overflow list KEEPS its dot -- those rows carry no pill
  // tint, so there the dot is the only identity signal rather than the third.
  const accent = resolveIdentityColor(identity.colourKey, theme)
  const groups = identity.groups
    .map((g) => ({ g, node: groupContent(g, { hidden, minimal, showPending, now, full: false }) }))
    .filter((x) => x.node !== null)
  const gap = minimal ? 'gap-1.5' : 'gap-2'
  const label = identity.plain && !minimal ? (identity.email ?? identity.name) : identity.name
  return (
    <span
      ref={pillRef}
      // Each identity sits in its own subtle rounded pill so the boundary
      // between people reads at a glance, rather than relying on whitespace.
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${compact ? 'min-w-0' : 'shrink-0'}`}
      style={{
        // Soft (26/6): the bar carries one of these per identity and they must
        // not shout over the meters they exist to frame.
        borderColor: `color-mix(in srgb, ${accent} 26%, transparent)`,
        background: `color-mix(in srgb, ${accent} 6%, transparent)`,
      }}
      title={tooltip(identity, snapshot, now, { withPercent: minimal, showPending })}
      data-testid="multi-account-pill"
      data-minimal={minimal ? 'true' : undefined}
    >
      <span
        className={`font-medium ${compact ? 'truncate' : ''}`}
        style={{ color: 'var(--text-on-chrome)' }}
        data-testid="multi-account-pill-label"
      >
        {label}
      </span>
      {/* Meters never shrink -- the label is what gives way when space is tight.
          COMPACT here: short codes and no trailing percentage. The exact figure
          is in each bar's tooltip, and the "+N" popover below stays fully
          labelled -- glanceable strip, detailed popover. Groups are never
          merged: each provider's meters stay in their own group, led by its
          mark, with a thin rule between them. */}
      <span className={`flex items-center shrink-0 ${gap}`}>
        {groups.length === 1 && !groupMarked(identity, groups[0].g)
          ? groups[0].node
          : groups.map(({ g, node }, i) => (
              <React.Fragment key={g.providerId}>
                {i > 0 && (
                  <span aria-hidden="true" className="shrink-0" style={{ width: 1, height: 10, background: 'var(--border-strong)' }} data-testid="multi-account-group-rule" />
                )}
                <span className={`flex items-center ${gap}`} data-testid={`multi-account-group-${g.providerId}`}>
                  {groupMarked(identity, g) && <ProviderMark providerId={g.providerId} size={13} title={providerNameOf(g.providerId, snapshot)} />}
                  {node}
                </span>
              </React.Fragment>
            ))}
      </span>
    </span>
  )
}

const OVERFLOW_POPOVER_W = 320

/**
 * "+N" control for the pills past the two rows. Opens a small popover with the
 * same dot/label/meters, one per line, and a sub-row per provider group. It
 * counts "accounts" while only Claude Code is in use, "identities" otherwise.
 *
 * Positioning: `position: fixed` off the button's rect (the ScreenshotButton
 * pattern) because BottomBar and its centre zone are `overflow-hidden` -- an
 * absolutely-positioned popover would be clipped by the footer.
 *
 * Dismissal follows the app's existing popover pattern (AiUsagePopover /
 * ScreenshotButton): a document mousedown probe, deliberately NOT a full-screen
 * backdrop div -- house rule, a backdrop that closes on click is dismissed
 * spuriously because Ctrl+C fires click events. Escape closes and hands focus
 * back to the button.
 */
function IdentityOverflow({
  accounts,
  hidden,
  theme,
  showPending,
  now,
  identities,
  snapshot,
}: {
  accounts: LiveIdentity[]
  hidden: string[]
  theme: 'dark' | 'light'
  showPending: boolean
  now: number
  /** Count them as identities (another provider than Claude Code is on). */
  identities: boolean
  snapshot: AccountsSnapshot | null
}) {
  const [open, setOpen] = React.useState(false)
  const [pos, setPos] = React.useState<{ left: number; bottom: number } | null>(null)
  const btnRef = React.useRef<HTMLButtonElement>(null)
  const popRef = React.useRef<HTMLDivElement>(null)

  const close = React.useCallback((refocus: boolean) => {
    setOpen(false)
    if (refocus) btnRef.current?.focus()
  }, [])

  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true)
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null
      if (!t) return
      if (popRef.current?.contains(t)) return
      if (btnRef.current?.contains(t)) return
      close(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    // Move focus into the popover so it is reachable (and Escapable) from the
    // keyboard, not just discoverable by mouse.
    popRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open, close])

  const toggle = () => {
    if (open) {
      close(false)
      return
    }
    const r = btnRef.current?.getBoundingClientRect()
    const left = r
      ? Math.max(8, Math.min(r.left, window.innerWidth - OVERFLOW_POPOVER_W - 8))
      : 8
    const bottom = r ? Math.max(8, window.innerHeight - r.top + 6) : 8
    setPos({ left, bottom })
    setOpen(true)
  }

  const noun = identities ? (accounts.length === 1 ? 'identity' : 'identities') : (accounts.length === 1 ? 'account' : 'accounts')
  const label = `${accounts.length} more ${noun}`

  return (
    <span className="flex items-center shrink-0">
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Show ${label}`}
        title={`${label} -- click for their usage`}
        data-testid="multi-account-overflow-toggle"
        className="px-1.5 py-px rounded-full text-[10px] font-medium tabular-nums focus-ring"
        style={{
          color: 'var(--text-secondary)',
          background: 'color-mix(in srgb, var(--brand) 14%, transparent)',
          border: '1px solid var(--border-strong)',
        }}
      >
        +{accounts.length}
      </button>
      {open && pos && (
        <div
          ref={popRef}
          role="dialog"
          aria-label="More account usage"
          tabIndex={-1}
          data-testid="multi-account-overflow-popover"
          className="account-overflow-pop fixed z-50 rounded-lg shadow-xl p-2.5 flex flex-col gap-2 focus-ring"
          style={{
            left: pos.left,
            bottom: pos.bottom,
            width: OVERFLOW_POPOVER_W,
            background: 'var(--surface-overlay)',
            border: '1px solid var(--border-strong)',
            color: 'var(--text-primary)',
          }}
        >
          <div
            className="text-[10px] uppercase tracking-wide"
            style={{ color: 'var(--text-secondary)' }}
          >
            {label}
          </div>
          {accounts.map((a) => (
            <div
              key={a.key}
              className="flex flex-col gap-1 min-w-0"
              data-testid="multi-account-overflow-row"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: resolveIdentityColor(a.colourKey, theme) }}
                />
                <span className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {a.plain ? (a.email ?? a.name) : a.name}
                </span>
                <span
                  className="ml-auto shrink-0 tabular-nums text-[10px]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {a.count} live
                </span>
              </span>
              {a.groups.map((g) => {
                const node = groupContent(g, { hidden, minimal: false, showPending, now, full: true })
                if (node === null) return null
                return (
                  <span key={g.providerId} className="flex flex-wrap items-center gap-2 pl-4" data-testid={`multi-account-overflow-group-${g.providerId}`}>
                    {groupMarked(a, g) && <ProviderMark providerId={g.providerId} size={13} title={providerNameOf(g.providerId, snapshot)} />}
                    {node}
                  </span>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </span>
  )
}

/**
 * Slim multi-account usage readout for the BottomBar: one pill per IDENTITY
 * (usage track MP5, Q1.2), each with a meter group per provider it has live
 * sessions of. Only renders when >=2 identities are live, so single-account
 * users see nothing. Reads data already in the session store (statusline- and
 * telemetry-driven) and the registry the renderer holds -- no new polling/IPC.
 * Which bars appear is curated INDEPENDENTLY of the per-session strip via
 * footerHiddenUsageBuckets (a footer-scoped denylist by bucket label).
 *
 * Layout (owner request, #378): one row whenever every pill fits in the free
 * footer width; wrap only when they truly do not, filling each row before the
 * next; at most two rows, the tail behind a "+N" overflow control. The rows are
 * computed from MEASURED widths (useMeasuredFooterRows), not from a count. The
 * footer is `min-h-7` (a MINIMUM) inside a flex column whose terminal pane
 * re-fits from a ResizeObserver, so growing it is safe -- nothing measures the
 * bar's height.
 */
export default function MultiAccountStatusline() {
  const sessions = useSessionStore((s) => s.sessions)
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const aliases = useSettingsStore((s) => s.settings.accountAliases)
  const overrides = useSettingsStore((s) => s.settings.accountColourOverrides)
  const hidden = useSettingsStore((s) => s.settings.footerHiddenUsageBuckets) ?? EMPTY_HIDDEN
  // Master status-line switch, same flag the session strip gates on. It does NOT
  // gate the live bars here (the footer has always shown whatever the store
  // holds); it gates only the PENDING placeholder, which is a promise that data
  // is on its way. With the switch off that promise is false. Absent
  // (pre-upgrade config) means on.
  const statusLineEnabled = useSettingsStore((s) => s.settings.statusLineEnabled ?? true)
  // Absent means the meters, so nobody's footer changes shape on upgrade.
  const minimal = useSettingsStore((s) => s.settings.footerAccountDisplay === 'dots')
  // With Codex in use the pills are people ("identities"); without it the
  // footer reads as it always has ("accounts").
  const codexOn = useSettingsStore((s) => usesCodex(s.settings))
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const theme = useResolvedTheme()

  const identities = React.useMemo(
    () => liveIdentityUsage(sessions, profiles, aliases, overrides, snapshot),
    [sessions, profiles, aliases, overrides, snapshot],
  )

  // D2: a window whose reset passes while nothing else changes still turns to
  // "no reading since" on time.
  const resets = React.useMemo(
    () => identities.flatMap((i) => i.groups.flatMap((g) => g.buckets.map((b) => b.resetsAt).filter(Boolean))),
    [identities],
  )
  useRenderAtNextReset(resets)
  const now = Date.now()

  // What a pill SHOWS decides its width: the denylist, minimal mode, the
  // pending placeholder and a window past its reset all change it without
  // changing the set of identities. The hook re-measures when this changes.
  const pastSignature = identities.map((i) => i.groups.map((g) => g.buckets.filter((b) => bucketPastReset(b, now)).length).join('.')).join(',')
  const contentSignature = `${hidden.join(',')}|${minimal ? 'dots' : 'meters'}|${statusLineEnabled ? 'p' : '-'}|${pastSignature}`
  const { layout, rootRef, pillRef } = useMeasuredFooterRows(identities, contentSignature)
  const { rows, overflow } = layout

  if (identities.length < 2) return null

  // Bug 3: a plain pill shows the FULL email + the real statusline progress bars
  // (RateLimitBar, same as SessionStatusStrip). BottomBar centres this cluster
  // along the footer. The footer-scoped denylist filters which bars show here,
  // so the user can e.g. keep only Fable in the footer to narrow the cluster.
  const multiRow = rows.length > 1

  return (
    <div
      ref={rootRef}
      // w-full: the strip spans its centre zone so its measured width IS the
      // free width between the runtime band and the disclaimer -- the number
      // the row layout is computed against. Shrink-to-fit (the old behaviour)
      // measured the cluster's own width, which is useless for deciding how
      // much room there is. Rows centre their pills inside it.
      className={`flex flex-col items-center w-full min-w-0 ${multiRow ? 'gap-1 py-1' : ''}`}
      data-testid="multi-account-statusline"
      data-account-rows={rows.length}
    >
      {rows.map((row, i) => (
        <div
          key={i}
          // The rows are sized by measurement, so a row never exceeds the zone
          // once the layout effect has run. flex-wrap stays as the safety net
          // for the frames before it has (first paint, a resize in flight):
          // an over-wide row wraps onto an extra line the footer can absorb
          // (its height is a MINIMUM, min-h-7), instead of spilling out of
          // BOTH sides of its centred zone and being clipped.
          className="flex flex-wrap items-center justify-center min-w-0 gap-y-1"
          // Inline px gap, the same constant the layout was computed with.
          style={{ columnGap: FOOTER_PILL_GAP_PX }}
          data-testid="multi-account-row"
        >
          {row.map((a) => (
            <IdentityPill
              key={a.key}
              identity={a}
              hidden={hidden}
              theme={theme}
              compact={multiRow}
              showPending={statusLineEnabled}
              minimal={minimal}
              now={now}
              snapshot={snapshot}
              pillRef={pillRef(a.key)}
            />
          ))}
          {i === rows.length - 1 && overflow.length > 0 && (
            <IdentityOverflow
              accounts={overflow}
              hidden={hidden}
              theme={theme}
              showPending={statusLineEnabled}
              now={now}
              identities={codexOn}
              snapshot={snapshot}
            />
          )}
        </div>
      ))}
    </div>
  )
}
