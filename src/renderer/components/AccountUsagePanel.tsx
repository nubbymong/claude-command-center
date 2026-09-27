import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useReauthAccount } from '../hooks/useReauthAccount'
import { resolveAccountColourKey } from '../../shared/account-chip-color'
import { resolveIdentityColor, type IdentityColorKey } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import { formatResetTime } from '../utils/terminalFormatting'
import PageFrame from './PageFrame'
import { ProviderMark } from './sidebar/Badges'
import { describeAuthWindow, type AuthWindowTone, type ProfileAuthInfo } from '../../shared/account-auth'
import type { AccountUsage, UsageBucket } from '../../shared/usage-types'
import { bucketPastReset, relAgo } from '../../shared/usage-labels'
import type { AccountProfile } from '../../shared/account-types'
import type { AccountsSnapshot, AccountView, ProviderAccountUsageView, ProviderId } from '../../shared/providers'
import { useClaudeOff } from '../lib/claudeOff'
import { useRenderAtNextReset } from '../hooks/useRenderAtNextReset'
import { useSettingsStore } from '../stores/settingsStore'
import { usesCodex } from '../onboarding/provider-choice'
import {
  useProviderAccountsStore, selectProviderAccounts, accountForLegacyId, accountDisplayName, providerView, signInMethodLabel,
} from '../stores/providerAccountsStore'

/** D5 (usage UX, approved as drawn): the one line the page shows for Claude
 *  Code while it is switched off. */
export const CLAUDE_OFF_USAGE_LINE = 'Claude Code is off. Turn it on in Settings, Accounts to see its accounts.'

/** Usage track MP4 (approved canvas, Account usage option A): the notes a
 *  Codex account shows in place of bars. */
export const NO_SESSION_YET_LINE = 'No session on this account yet. Its allowance shows after the first one.'
export const PER_TOKEN_LINE = 'Billed per token, so there is no plan allowance.'

const PARKED_LINE = 'Parked \u2014 not polled. Reactivate this account in Settings \u203a Accounts to use it again.'
const COUNTDOWN_LINE = 'The countdown is the point at which an interactive sign-in becomes unavoidable \u2014 the shorter-lived token behind each session renews itself and is not shown.'

// The providers this page has a section for, in the order they show. The page
// asks for a provider's accounts and usage by its id; it never branches on it.
const CLAUDE: ProviderId = 'claude'
const CODEX: ProviderId = 'codex'
const PROVIDER_NAME: Readonly<Record<ProviderId, string>> = { claude: 'Claude Code', codex: 'Codex' }

/** A window focus reloads the page's Codex views at most this often. */
export const FOCUS_REFRESH_MS = 60_000
/** In the registry-change bookkeeping: the stream read this account, before
 *  its sign-in state was known here. */
const READ_BY_STREAM = 'read-by-stream'

const TONE_TEXT: Record<AuthWindowTone, string> = {
  expired: 'text-red',
  critical: 'text-red',
  warning: 'text-yellow',
  ok: 'text-overlay0',
  unknown: 'text-overlay0',
}

const peopleIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="3.25" />
    <path d="M5.5 19.5c0-3.4 3-5.5 6.5-5.5s6.5 2.1 6.5 5.5" />
  </svg>
)

/** An account's identity as a card shows it: its name, when it has one, and
 *  its colour. */
export interface CardIdentity {
  name?: string
  colourKey?: string
}

function identityOf(snapshot: AccountsSnapshot | null, account: AccountView | undefined): CardIdentity | undefined {
  if (!account) return undefined
  const identity = snapshot?.identities.find((i) => i.id === account.identityId)
  if (!identity) return undefined
  const name = identity.friendlyName?.trim()
  return name ? { name, colourKey: identity.colourKey } : { colourKey: identity.colourKey }
}

// All-accounts usage overview. A full PageFrame view (reached from the nav-rail
// person icon, shown with 2+ accounts across the providers that are on) rather
// than a slide-in right-bar, so it matches Tokenomics/Memory and lives in the
// `panels` typography region -- which (with rem sizing below) lets Font & Size
// scale it. Grouped by provider (usage track MP4): Claude Code's accounts are
// read directly, no session needed, with a per-card "Sign in" for an expired
// token; Codex's show an open session's figure, else the last one in the
// account's own history.
export default function AccountUsagePanel({ onClose, onReauthNavigate, onOpenTokenomics }: {
  onClose: () => void
  /** Switch the app to the sessions view so the user sees the login shell. */
  onReauthNavigate: () => void
  /** Opens Tokenomics (the foot's link). */
  onOpenTokenomics?: () => void
}) {
  const theme = useResolvedTheme()
  const reauth = useReauthAccount()
  // D5: with Claude Code switched off the page reads nothing of it -- not the
  // credential state (authInfo reads every account's credential file), not
  // the usage stream -- and shows one line. Turning it back on loads again.
  const claudeOff = useClaudeOff()
  // Codex has a section only once it is answered on: a user who does not use
  // Codex sees the page as it always was, and nothing of Codex is asked for.
  const codexOn = useSettingsStore((s) => usesCodex(s.settings))
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const codexAccounts = useMemo(() => selectProviderAccounts(snapshot, CODEX), [snapshot])
  // The account list drives the SKELETON rows (a local read, so it resolves at
  // once); usage streams in per account and fills each row as it lands. null =
  // the list has not resolved yet (a placeholder skeleton or two show meanwhile).
  const [profiles, setProfiles] = useState<AccountProfile[] | null>(null)
  const [usageByProfile, setUsageByProfile] = useState<Record<string, AccountUsage>>({})
  const [authInfo, setAuthInfo] = useState<Record<string, ProfileAuthInfo>>({})
  // True while a stream is in flight: a profile with no result yet reads as a
  // skeleton WHILE streaming, and as a terminal "couldn't load" row once the
  // stream has settled — so a failed load never shimmers forever.
  const [streaming, setStreaming] = useState(true)
  const [loadError, setLoadError] = useState(false)
  // Codex's accounts come from the registry the app already holds; their
  // views stream in the same way, one per account.
  const [codexViews, setCodexViews] = useState<Record<string, ProviderAccountUsageView>>({})
  const [codexStreaming, setCodexStreaming] = useState(codexOn)
  // Main answered that Codex is off (switched off in between): no section.
  const [codexStreamOff, setCodexStreamOff] = useState(false)
  // Generation guards, one per provider: a Refresh (or that provider's switch
  // flipping) supersedes its in-flight load, so a late result from the previous
  // stream (or its settle) is ignored rather than repopulating a row the new
  // load has just reset. Each provider loads on its own: switching Codex on or
  // off never re-asks Claude Code, and the other way round.
  const claudeGen = useRef(0)
  const codexGen = useRef(0)
  // The Codex accounts (and each one's sign-in state) as of the last stream
  // or the last registry change handled, so a change after it reads that
  // account again.
  const codexSeen = useRef<Map<string, string>>(new Map())
  const codexAccountsRef = useRef(codexAccounts)
  codexAccountsRef.current = codexAccounts

  const loadClaude = useCallback(async (opts: { quiet?: boolean } = {}) => {
    const gen = ++claudeGen.current
    if (claudeOff) {
      setUsageByProfile({})
      setProfiles([])
      setLoadError(false)
      setStreaming(false)
      return
    }
    // Clear usage so every row returns to a skeleton, then re-stream (a quiet
    // reload keeps the figures shown until each new one lands). The account
    // list and the credential state are both local file reads, so they resolve
    // at once and independently of the network usage fetch -- one slow account
    // must not hold back the others' rows or the forced-login countdown.
    if (!opts.quiet) setUsageByProfile({})
    setLoadError(false)
    setStreaming(true)
    try {
      const [profs, auth] = await Promise.all([
        window.electronAPI.accountProfiles.list(),
        window.electronAPI.accountProfiles.authInfo().catch(() => [] as ProfileAuthInfo[]),
      ])
      if (claudeGen.current !== gen) return // a newer load took over
      setProfiles(profs)
      setAuthInfo(Object.fromEntries(auth.map((a) => [a.profileId, a])))
      // Stream each account's usage in as it resolves (plan P3): an OPEN account
      // snaps in instantly from its live figure (no call), a CLOSED one fills in
      // as its staggered call lands. No all-or-nothing "Loading..." gate.
      await window.electronAPI.accountUsage.fetchAllStream((usage) => {
        if (claudeGen.current !== gen) return // ignore a superseded stream's result
        setUsageByProfile((prev) => ({ ...prev, [usage.profileId]: usage }))
      })
    } catch {
      // A rejected list()/stream (a corrupt profiles read, say) must not leave the
      // page shimmering: record the error so unresolved rows show a terminal state
      // and an empty list reads as an error rather than "No accounts found".
      if (claudeGen.current === gen) { setLoadError(true); setProfiles((prev) => prev ?? []) }
    } finally {
      if (claudeGen.current === gen) setStreaming(false)
    }
  }, [claudeOff])

  // `read` (MP8 round 2, ADR-022 bound 7): a closed Codex account is read
  // afresh only when the page opens or on Refresh; the window-focus reload
  // shows the live, kept or last-seen figure only.
  const loadCodex = useCallback(async (opts: { quiet?: boolean; read?: boolean } = {}) => {
    const gen = ++codexGen.current
    if (!opts.quiet) setCodexViews({})
    setCodexStreamOff(false)
    codexSeen.current = new Map(codexAccountsRef.current.map((a) => [a.id, a.lastKnownAuthState]))
    if (!codexOn) { setCodexStreaming(false); return }
    setCodexStreaming(true)
    try {
      const api = window.electronAPI?.providerAccounts
      if (!api?.usageStream) return // no stream: the rows turn to Retry
      const r = await api.usageStream(CODEX, (view) => {
        if (codexGen.current !== gen || !view || typeof view.accountId !== 'string') return
        // The stream read this account: a registry copy arriving after it
        // started is not a change to read it again for.
        if (!codexSeen.current.has(view.accountId)) codexSeen.current.set(view.accountId, READ_BY_STREAM)
        setCodexViews((prev) => ({ ...prev, [view.accountId]: view }))
      }, { read: opts.read !== false })
      if (codexGen.current === gen && r && r.ok === true && r.provider === 'off') setCodexStreamOff(true)
    } catch {
      // A failed stream leaves the unresolved rows to Retry, one account each.
    } finally {
      if (codexGen.current === gen) setCodexStreaming(false)
    }
  }, [codexOn])

  useEffect(() => { void loadClaude() }, [loadClaude])
  useEffect(() => { void loadCodex() }, [loadCodex])
  // Usage track MP8: the page closing stops its Codex stream in main, and a
  // fresh read under way with it: nothing is read for a page no one sees.
  useEffect(() => () => {
    try { void window.electronAPI?.providerAccounts?.usageStreamStop?.(CODEX)?.catch(() => {}) } catch { /* the page is going anyway */ }
  }, [])
  // Refresh (and a window focus) reloads both.
  const load = useCallback(async (opts: { quiet?: boolean } = {}) => {
    await Promise.all([loadClaude(opts), loadCodex(opts)])
  }, [loadClaude, loadCodex])

  // Coming back to the window reloads Codex, quietly (the figures stay until
  // each new one lands), at most once per FOCUS_REFRESH_MS. Codex only: its
  // views are read locally, while Claude Code's closed accounts call a
  // rate-limited endpoint, so Claude Code keeps its own cadence (the page
  // opening, Refresh, a card's Retry).
  const lastFocusLoad = useRef(Date.now())
  useEffect(() => {
    const onFocus = () => {
      const t = Date.now()
      if (t - lastFocusLoad.current < FOCUS_REFRESH_MS) return
      lastFocusLoad.current = t
      void loadCodex({ quiet: true, read: false })
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [loadCodex])

  const refreshOne = useCallback(async (profileId: string) => {
    try {
      const one = await window.electronAPI.accountUsage.fetchOne(profileId)
      if (one) setUsageByProfile((prev) => ({ ...prev, [profileId]: one }))
    } catch { /* leave the stale row */ }
  }, [])

  // `read`: a card's Retry only; an account the registry changed shows the
  // live, kept or last-seen figure (MP8 round 2, ADR-022 bound 7).
  const refreshCodexOne = useCallback(async (accountId: string, read: boolean) => {
    try {
      const r = await window.electronAPI.providerAccounts.usageOne(accountId, { read })
      if (r && r.ok === true && r.usage) setCodexViews((prev) => ({ ...prev, [accountId]: r.usage }))
    } catch { /* it stays a Retry row */ }
  }, [])

  // The registry changed after the stream: an account added since, or one
  // whose sign-in state changed (signed back in, say), reads again, that
  // account alone. A parked account reads nothing.
  useEffect(() => {
    if (!codexOn || codexStreaming) return
    const seen = codexSeen.current
    for (const a of codexAccounts) {
      if (a.lifecycle === 'inactive') continue
      const before = seen.get(a.id)
      if (before === READ_BY_STREAM) continue
      if (before === undefined || before !== a.lastKnownAuthState) void refreshCodexOne(a.id, false)
    }
    codexSeen.current = new Map(codexAccounts.map((a) => [a.id, a.lastKnownAuthState]))
  }, [codexAccounts, codexOn, codexStreaming, refreshCodexOne])

  const onSignIn = (row: AccountUsage) => {
    reauth({ id: row.profileId, name: row.name }, () => void refreshOne(row.profileId))
    onReauthNavigate()
    onClose()
  }

  // A signed-out Codex account signs in again from Settings, Accounts.
  const openAccountsSettings = () => {
    window.dispatchEvent(new CustomEvent('app:openSettings', { detail: { tab: 'accounts' } }))
  }

  const resets = useMemo(() => {
    const out: string[] = []
    for (const u of Object.values(usageByProfile)) for (const b of u.buckets ?? []) if (b.resetsAt) out.push(b.resetsAt)
    for (const v of Object.values(codexViews)) for (const b of v.buckets ?? []) if (b.resetsAt) out.push(b.resetsAt)
    return out
  }, [usageByProfile, codexViews])
  useRenderAtNextReset(resets)
  const now = Date.now()

  // Sections (the approved drawing): Codex has one once it has an account to
  // show; Claude Code's shows while it is on, unless its list came back empty
  // and Codex has one. Headings only show beside Codex: Claude Code's page on
  // its own is the page as it was.
  const codexSection = codexOn && !codexStreamOff && codexAccounts.length > 0
  const claudeSection = !claudeOff && (profiles === null || profiles.length > 0 || loadError || !codexSection)
  const bothSections = claudeSection && codexSection

  const refreshAction = (
    <button
      onClick={() => void load()}
      className="text-xs px-2 py-0.5 rounded text-overlay1 hover:text-text hover:bg-surface0 transition-colors"
      title="Refresh all"
    >
      Refresh
    </button>
  )

  return (
    <PageFrame title="Account usage" icon={peopleIcon} iconAccent="mauve" onClose={onClose} actions={refreshAction}>
      <div className="max-w-3xl mx-auto p-4 flex flex-col gap-3">
        {claudeOff && (
          <p className="text-[0.8125rem] text-overlay0" data-testid="account-usage-claude-off">{CLAUDE_OFF_USAGE_LINE}</p>
        )}
        {claudeSection && (<>
        {bothSections && <SectionHeading providerId={CLAUDE} name={providerView(snapshot, CLAUDE)?.displayName ?? PROVIDER_NAME[CLAUDE]} count={loadError ? null : profiles?.length ?? null} />}
        {profiles === null
          // The list is a local read; the placeholders below cover only the frame
          // or two before it resolves, so the page never flashes empty.
          ? [0, 1].map((i) => <UsageSkeletonCard key={`sk-${i}`} />)
          : profiles.length === 0
            ? <p className="text-[0.8125rem] text-overlay0">{loadError ? 'Couldn’t load account usage. Use Refresh to try again.' : 'No accounts found.'}</p>
            : profiles.map((p) => {
                const usage = usageByProfile[p.id]
                if (usage) {
                  const identity = identityOf(snapshot, accountForLegacyId(snapshot, CLAUDE, p.id))
                  return <AccountCard key={p.id} row={usage} auth={authInfo[p.id]} identity={identity} theme={theme} now={now} onSignIn={() => onSignIn(usage)} />
                }
                // No result yet: a skeleton while the stream runs; once it has
                // settled without one (a rare stream-level failure), a terminal
                // row with a per-account retry rather than an endless shimmer.
                return streaming
                  ? <UsageSkeletonCard key={p.id} />
                  : <UsageUnavailableRow key={p.id} name={p.accountEmail || p.name} onRetry={() => void refreshOne(p.id)} />
              })}
        </>)}
        {codexSection && (<>
        <SectionHeading providerId={CODEX} name={providerView(snapshot, CODEX)?.displayName ?? PROVIDER_NAME[CODEX]} count={codexAccounts.length} />
        {codexAccounts.map((a) => {
          const view = codexViews[a.id]
          const parked = a.lifecycle === 'inactive'
          if (!view && !parked) {
            return codexStreaming
              ? <UsageSkeletonCard key={a.id} />
              : <UsageUnavailableRow key={a.id} name={accountDisplayName(snapshot, a)} onRetry={() => void refreshCodexOne(a.id, true)} />
          }
          if (view && (view.status === 'error' || view.status === 'off')) {
            return <UsageUnavailableRow key={a.id} name={accountDisplayName(snapshot, a)} onRetry={() => void refreshCodexOne(a.id, true)} />
          }
          const identity = identityOf(snapshot, a)
          const provider = providerView(snapshot, a.providerId) ?? { providerId: a.providerId, displayName: PROVIDER_NAME[a.providerId] }
          return (
            <CodexAccountCard
              key={a.id}
              account={a}
              view={view ?? { accountId: a.id, providerId: a.providerId, status: 'inactive', buckets: [] }}
              name={accountDisplayName(snapshot, a)}
              method={a.external ? null : signInMethodLabel(a, provider)}
              colour={identity?.colourKey ? resolveIdentityColor(identity.colourKey as IdentityColorKey, theme) : null}
              now={now}
              onSignInAgain={openAccountsSettings}
            />
          )
        })}
        </>)}
        <p className="text-[0.6875rem] text-overlay0 leading-relaxed pt-1" data-testid="account-usage-foot">
          Allowances only. Token use and estimated cost are in{' '}
          {onOpenTokenomics
            ? <button type="button" onClick={onOpenTokenomics} className="text-blue hover:underline">Tokenomics</button>
            : 'Tokenomics'}.
          {claudeSection && (<><br />{COUNTDOWN_LINE}</>)}
        </p>
      </div>
    </PageFrame>
  )
}

// A provider's section heading (shown beside another provider's): its mark,
// its name and how many of its accounts are listed.
function SectionHeading({ providerId, name, count }: { providerId: ProviderId; name: string; count: number | null }) {
  return (
    <h2
      className="flex items-center gap-2 mt-1 -mb-0.5 text-[0.75rem] font-semibold text-subtext0 uppercase tracking-[0.05em]"
      data-testid={`account-usage-section-${providerId}`}
    >
      <ProviderMark providerId={providerId} size={16} />
      <span>{name}</span>
      {count !== null && (
        <span className="ml-auto font-normal text-[0.6875rem] normal-case tracking-normal" style={{ color: 'var(--text-muted)' }}>
          {count} account{count === 1 ? '' : 's'}
        </span>
      )}
    </h2>
  )
}

// One loading row (plan P3): the card frame with its identity and bars replaced by
// a calm sweep, shown until this account's usage streams in. Reuses the statusline
// pending-track shimmer (styles.css) so there is no second animation to maintain,
// and it stops under prefers-reduced-motion. role=status/aria-busy announces the
// load without reading empty shimmer as content.
function UsageSkeletonCard() {
  const shimmer = 'statusline-pending-track bg-surface1 rounded'
  return (
    <div
      className="rounded-xl border border-surface0/70 px-4 py-3.5 bg-surface0/20"
      role="status"
      aria-busy="true"
      aria-label="Loading account usage"
      data-testid="account-usage-skeleton"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className={`${shimmer} w-2.5 h-2.5 rounded-[3px] shrink-0`} />
        <span className={`${shimmer} h-3.5`} style={{ width: '11rem' }} />
        <span className={`${shimmer} ml-auto h-3 rounded-full`} style={{ width: '3.5rem' }} />
      </div>
      <div className="flex flex-col gap-2.5">
        {['5h', 'Weekly'].map((lbl) => (
          <div key={lbl} className="flex items-center gap-2.5">
            <span className="text-[0.8125rem] text-overlay0 shrink-0" style={{ minWidth: '3.625rem' }}>{lbl}</span>
            <span className={`${shimmer} flex-1 h-2 rounded-full`} />
          </div>
        ))}
      </div>
    </div>
  )
}

// Terminal state for a row whose usage never arrived because the stream itself
// failed (rare — a per-account fetch resolves to an error-status row, not a
// missing one). Shown instead of an endless skeleton, with a per-account retry.
function UsageUnavailableRow({ name, onRetry }: { name: string; onRetry: () => void }) {
  return (
    <div className="rounded-xl border border-surface0/70 px-4 py-3.5 bg-surface0/20 flex items-center justify-between gap-2" data-testid="account-usage-unavailable">
      <span className="text-[0.8125rem] text-overlay0 min-w-0">
        <span className="text-text font-medium break-all" data-testid="account-usage-unavailable-name">{name}</span>{' '}
        {'Couldn\u2019t load this account\u2019s usage.'}
      </span>
      <button
        onClick={onRetry}
        aria-label={`Retry ${name}`}
        className="text-[0.75rem] px-2 py-0.5 rounded border border-surface1 text-overlay1 hover:text-text hover:border-blue/40 transition-colors shrink-0"
      >
        Retry
      </button>
    </div>
  )
}

// Bigger, panel-specific usage bar (the statusline RateLimitBar is deliberately
// tiny). Full labels, readable percentages, monotonic warm ramp. D2: a window
// whose reset has passed has no current figure, so it says when it reset and
// shows no bar.
function UsageBar({ bucket, now }: { bucket: UsageBucket; now: number }) {
  if (bucketPastReset(bucket, now)) {
    return (
      <div className="flex items-center gap-2.5" data-testid="account-usage-past-reset">
        <span className="text-[0.8125rem] text-subtext0 shrink-0" style={{ minWidth: '3.625rem' }}>{bucket.label}</span>
        <span className="flex-1 text-[0.75rem]" style={{ color: 'var(--text-muted)' }}>Reset {formatResetTime(bucket.resetsAt)}, no reading since</span>
      </div>
    )
  }
  const clamped = Math.min(100, Math.max(0, bucket.percent))
  const color = clamped >= 90 ? 'var(--color-red)' : clamped >= 70 ? 'var(--color-peach)' : clamped >= 50 ? 'var(--color-yellow)' : 'var(--color-green)'
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-[0.8125rem] text-subtext0 shrink-0" style={{ minWidth: '3.625rem' }}>{bucket.label}</span>
      <span className="flex-1 h-2 rounded-full bg-surface1 overflow-hidden" role="progressbar" aria-label={`${bucket.label} usage`} aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
        <span className="block h-full rounded-full transition-[width] duration-300" style={{ width: `${clamped}%`, backgroundColor: color }} />
      </span>
      <span className="text-[0.8125rem] text-text tabular-nums shrink-0" style={{ minWidth: '2.5rem', textAlign: 'right' }}>{Math.round(clamped)}%</span>
      {bucket.resetsAt && (
        <span className="text-[0.75rem] shrink-0" style={{ color: 'var(--text-muted)' }}>resets {formatResetTime(bucket.resetsAt)}</span>
      )}
    </div>
  )
}

// A small rounded label on a card's heading: Default, Inactive, the plan.
// `end` pushes it (and what follows) to the right.
function CardPill({ children, end, plan }: { children: React.ReactNode; end?: boolean; plan?: boolean }) {
  return (
    <span
      className={`${end ? 'ml-auto ' : ''}text-[0.625rem] ${plan ? '' : 'text-overlay0 '}border border-surface1 rounded-full px-1.5 py-px shrink-0`}
      style={plan ? { color: 'var(--text-secondary)' } : undefined}
      data-testid="account-usage-pill"
    >
      {children}
    </span>
  )
}

function creditsText(c: NonNullable<AccountUsage['credits']>): string {
  if (!c.enabled) {
    const why = c.disabledReason === 'out_of_credits' ? 'Out of credits' : 'Off'
    return c.used > 0 ? `${why} · ${fmtMoney(c.used, c.currency)} used` : why
  }
  if (c.remaining != null) return `${fmtMoney(c.remaining, c.currency)} left`
  return `${fmtMoney(c.used, c.currency)} used`
}

export function AccountCard({
  row,
  auth,
  identity,
  theme,
  now = Date.now(),
  onSignIn,
}: {
  row: AccountUsage
  auth?: ProfileAuthInfo
  /** The account's identity in the registry: its name leads the card and its
   *  colour is the chip's. Absent: the email alone, coloured from it. */
  identity?: CardIdentity
  theme: 'dark' | 'light'
  /** The time the card is drawn at (ages and passed resets). */
  now?: number
  onSignIn: () => void
}) {
  const dot = resolveIdentityColor(
    identity?.colourKey ? (identity.colourKey as IdentityColorKey) : resolveAccountColourKey(row.email ?? undefined, undefined, undefined),
    theme,
  )
  const name = identity?.name?.trim()
  const hasName = !!name && name !== row.email
  // Parked account: undefined active is treated as active (a main process that
  // predates the field never greys a card). Inactive accounts are never network
  // fetched, so they carry no live buckets — the card just states that and
  // offers no sign-in (opening a login shell for an account the user parked
  // bypasses the switcher's own active-guard).
  const isInactive = row.status === 'inactive' || row.active === false
  // The provider is off: nothing of this account was read, so there is
  // nothing to act on and no countdown to show.
  const isOff = row.status === 'off'
  const quiet = isInactive || isOff
  // Computed at render against the wall clock; the calculation itself is pure and
  // lives in shared/ so main and renderer cannot disagree about what a credential
  // state means.
  const window_ = auth && !isOff ? describeAuthWindow(auth, Date.now()) : null
  const duplicates = auth?.duplicateOfProfileIds ?? []
  return (
    <div className={`rounded-xl border border-surface0/70 px-4 py-3.5 ${isInactive ? 'bg-surface0/10 opacity-60' : 'bg-surface0/20'}`}>
      <div className="flex items-center gap-2 mb-2.5 min-w-0">
        <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ backgroundColor: dot }} data-testid="account-usage-chip" />
        {/* The identity's name, then the full email beside it; with no name, the
            full email alone, never truncated (accounts are distinct even when
            emails look similar). */}
        <span className={`text-[0.9375rem] text-text font-medium ${hasName ? 'shrink-0' : 'break-all'}`} data-testid="account-usage-name">
          {hasName ? name : (row.email || row.name)}
        </span>
        {hasName && row.email && (
          <span className="text-[0.75rem] break-all min-w-0" style={{ color: 'var(--text-muted)' }} data-testid="account-usage-sub">{row.email}</span>
        )}
        {row.isPrimary && <span className="text-[0.625rem] text-overlay0 border border-surface1 rounded-full px-1.5 py-px shrink-0">Primary</span>}
        {isInactive && <span className="ml-auto text-[0.625rem] text-overlay0 border border-surface1 rounded-full px-1.5 py-px shrink-0">Inactive</span>}
        {/* A working sign-in gets a refresh too, not just a broken one: the whole
            point is to act BEFORE the forced login, and previously the only way to
            learn it was coming was for it to arrive. Never for a parked account. */}
        {!quiet && row.status !== 'needs-login' && (
          <button
            onClick={onSignIn}
            title="Sign in again now to reset this account's countdown"
            className="ml-auto text-[0.75rem] px-2 py-0.5 rounded border border-surface1 text-overlay1 hover:text-text hover:border-blue/40 transition-colors shrink-0"
          >
            Refresh sign-in
          </button>
        )}
      </div>

      {isInactive && (
        <p className="text-[0.8125rem] text-overlay0">{PARKED_LINE}</p>
      )}

      {isOff && (
        <p className="text-[0.8125rem] text-overlay0">Claude Code is off: nothing is read for this account.</p>
      )}

      {!quiet && duplicates.length > 0 && (
        <div className="mb-2.5 px-2.5 py-1.5 rounded-lg bg-red/10 border border-red/25 text-[0.75rem] text-red">
          This profile and {duplicates.length === 1 ? 'another profile' : `${duplicates.length} other profiles`} are
          signed into the SAME account. Each time one refreshes, the others&apos; sign-ins are invalidated — which is
          why they keep expiring. Sign the duplicates in as their own accounts.
        </div>
      )}

      {!quiet && auth?.identityMismatch && duplicates.length === 0 && (
        <div className="mb-2.5 px-2.5 py-1.5 rounded-lg bg-yellow/10 border border-yellow/25 text-[0.75rem] text-yellow">
          Labelled {auth.accountEmail} but signed in as {auth.oauthEmail}.
        </div>
      )}

      {row.status === 'ok' && row.buckets.length > 0 && (
        <div className="flex flex-col gap-2">
          {row.buckets.map((b) => <UsageBar key={b.key} bucket={b} now={now} />)}
          {row.credits && (
            <div className="flex items-center justify-between text-[0.8125rem] mt-1 pt-2 border-t border-surface0/60">
              <span className="text-overlay1">Credits</span>
              <span className={`tabular-nums ${row.credits.enabled ? 'text-text' : 'text-overlay1'}`}>{creditsText(row.credits)}</span>
            </div>
          )}
        </div>
      )}

      {row.status === 'ok' && row.buckets.length === 0 && (
        <p className="text-[0.8125rem] text-overlay0">No usage limits reported.</p>
      )}

      {!isInactive && row.status === 'needs-login' && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[0.8125rem] text-overlay0">{row.detail === 'session expired' ? 'Sign-in expired' : 'Not signed in'}</span>
          <button
            onClick={onSignIn}
            className="text-[0.8125rem] px-3 py-1.5 rounded-lg bg-blue text-crust font-medium hover:bg-blue/90 transition-colors shrink-0"
          >
            Sign in
          </button>
        </div>
      )}

      {row.status === 'error' && (
        <p className="text-[0.8125rem] text-overlay0">
          {row.detail?.startsWith('signed in')
            ? 'Signed in — open a session to refresh usage.'
            : `Couldn't load usage${row.detail ? ` (${row.detail})` : ''}.`}
        </p>
      )}

      {!quiet && (
        <div className="flex items-center justify-between gap-2 mt-2">
          {row.status === 'ok' ? (
            <p className="text-[0.6875rem] text-overlay0">
              {row.stale ? `Last updated ${relAgo(row.fetchedAt, now)} \u00b7 couldn't refresh` : `Updated ${relAgo(row.fetchedAt, now)}`}
            </p>
          ) : (
            <span />
          )}
          {window_ && (
            <p className={`text-[0.6875rem] tabular-nums shrink-0 ${TONE_TEXT[window_.tone]}`}>{window_.label}</p>
          )}
        </div>
      )}
    </div>
  )
}

/** When a Codex card's figure is from: "Updated <age>" for an open
 *  session's figure (or a fresh read), "As of <age>, from its latest session"
 *  for the last one in its history. */
function readingLine(view: ProviderAccountUsageView, now: number): string | null {
  const age = typeof view.readingAt === 'number' ? relAgo(view.readingAt, now) : ''
  if (view.source === 'last-seen') return age ? `As of ${age}, from its latest session` : 'From its latest session'
  return age ? `Updated ${age}` : null
}

/**
 * A Codex account's card (usage track MP4, the approved canvas): the
 * identity's chip (or "~" for this computer's own sign-in), the account's
 * name and how it signs in, Default and the plan; its bars; when the figure
 * is from. Never a sign-in countdown: its only source would be the
 * credential file, which the app never reads. A signed-out account offers
 * "Sign in again" (in Settings, Accounts).
 */
export function CodexAccountCard({
  account,
  view,
  name,
  method,
  colour,
  now,
  onSignInAgain,
}: {
  account: AccountView
  view: ProviderAccountUsageView
  name: string
  /** How it signs in ("ChatGPT sign-in", "API key"); null for none. */
  method: string | null
  /** The identity's chip colour; null for none. */
  colour: string | null
  now: number
  onSignInAgain: () => void
}) {
  const parked = account.lifecycle === 'inactive' || view.status === 'inactive'
  const plan = view.planLabel || account.planLabel
  const shown = (view.status === 'ok' || view.status === 'not-signed-in') && view.buckets.length > 0
  const line = shown ? readingLine(view, now) : null
  return (
    <div
      className={`rounded-xl border border-surface0/70 px-4 py-3.5 ${parked ? 'bg-surface0/10 opacity-60' : 'bg-surface0/20'}`}
      data-testid="account-usage-codex-card"
    >
      <div className="flex items-center gap-2 mb-2.5 min-w-0">
        {account.external
          ? (
            <span
              aria-hidden="true"
              className="w-2.5 shrink-0 text-center font-bold text-[0.875rem] leading-[0.625rem]"
              style={{ color: 'var(--text-muted)' }}
              data-testid="account-usage-external"
            >
              ~
            </span>
          )
          : <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ backgroundColor: colour ?? 'var(--text-muted)' }} data-testid="account-usage-chip" />}
        <span className="text-[0.9375rem] text-text font-medium shrink-0" data-testid="account-usage-name">{name}</span>
        {method && (
          <span className="text-[0.75rem] break-all min-w-0" style={{ color: 'var(--text-muted)' }} data-testid="account-usage-sub">{method}</span>
        )}
        {account.isProviderDefault && <CardPill>Default</CardPill>}
        {parked ? <CardPill end>Inactive</CardPill> : plan ? <CardPill end plan>{plan}</CardPill> : null}
      </div>

      {parked ? (
        <p className="text-[0.8125rem] text-overlay0">{PARKED_LINE}</p>
      ) : view.status === 'no-session-yet' ? (
        <p className="text-[0.8125rem] text-overlay0">{NO_SESSION_YET_LINE}</p>
      ) : view.status === 'per-token' ? (
        <p className="text-[0.8125rem] text-overlay0">{PER_TOKEN_LINE}</p>
      ) : (
        <>
          {shown && (
            <div className="flex flex-col gap-2">
              {view.buckets.map((b) => <UsageBar key={b.key} bucket={b} now={now} />)}
            </div>
          )}
          {view.status === 'not-signed-in' && (
            <div className={`flex items-center justify-between gap-2 ${shown ? 'mt-2' : ''}`}>
              <span className="text-[0.8125rem] text-overlay0">Signed out</span>
              <button
                onClick={onSignInAgain}
                className="text-[0.8125rem] px-3 py-1.5 rounded-lg bg-blue text-crust font-medium hover:bg-blue/90 transition-colors shrink-0"
              >
                Sign in again
              </button>
            </div>
          )}
          {line && (
            <div className="flex items-center justify-between gap-2 mt-2">
              <p className="text-[0.6875rem] text-overlay0">{line}</p>
              <span />
            </div>
          )}
        </>
      )}
    </div>
  )
}

function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}
