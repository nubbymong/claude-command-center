import React, { useEffect, useState, useCallback } from 'react'
import { useReauthAccount } from '../hooks/useReauthAccount'
import { resolveAccountColourKey } from '../../shared/account-chip-color'
import { resolveIdentityColor } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import { formatResetTime } from '../utils/terminalFormatting'
import PageFrame from './PageFrame'
import { describeAuthWindow, type AuthWindowTone, type ProfileAuthInfo } from '../../shared/account-auth'
import type { AccountUsage, UsageBucket } from '../../shared/usage-types'

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

// All-accounts usage overview. A full PageFrame view (reached from the nav-rail
// person icon, shown only with 2+ accounts) rather than a slide-in right-bar, so
// it matches Tokenomics/Memory and lives in the `panels` typography region --
// which (with rem sizing below) lets Font & Size scale it. Fetches each account's
// usage directly -- no session needed -- and offers a per-card "Sign in" for
// accounts whose token has expired.
export default function AccountUsagePanel({ onClose, onReauthNavigate }: {
  onClose: () => void
  /** Switch the app to the sessions view so the user sees the login shell. */
  onReauthNavigate: () => void
}) {
  const theme = useResolvedTheme()
  const reauth = useReauthAccount()
  const [rows, setRows] = useState<AccountUsage[] | null>(null)
  const [authInfo, setAuthInfo] = useState<Record<string, ProfileAuthInfo>>({})
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // Credential state is local file reads, so it resolves immediately and
      // independently of the network usage fetch — one slow account must not
      // hold back the forced-login countdown for the others.
      const [data, auth] = await Promise.all([
        window.electronAPI.accountUsage.fetchAll(),
        window.electronAPI.accountProfiles.authInfo().catch(() => [] as ProfileAuthInfo[]),
      ])
      setRows(data)
      setAuthInfo(Object.fromEntries(auth.map((a) => [a.profileId, a])))
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const refreshOne = useCallback(async (profileId: string) => {
    try {
      const one = await window.electronAPI.accountUsage.fetchOne(profileId)
      if (one) setRows((prev) => (prev ? prev.map((r) => (r.profileId === profileId ? one : r)) : prev))
    } catch { /* leave the stale row */ }
  }, [])

  const onSignIn = (row: AccountUsage) => {
    reauth({ id: row.profileId, name: row.name }, () => void refreshOne(row.profileId))
    onReauthNavigate()
    onClose()
  }

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
      <div className="max-w-3xl mx-auto p-4 space-y-3">
        {loading && !rows && <p className="text-[0.8125rem] text-overlay0">Loading usage for all accounts…</p>}
        {rows && rows.length === 0 && <p className="text-[0.8125rem] text-overlay0">No accounts found.</p>}
        {rows?.map((row) => (
          <AccountCard
            key={row.profileId}
            row={row}
            auth={authInfo[row.profileId]}
            theme={theme}
            onSignIn={() => onSignIn(row)}
          />
        ))}
        <p className="text-[0.6875rem] text-overlay0 leading-relaxed pt-1">
          Usage is read live from each account, no session required. Signing in refreshes only that account.
          The countdown is the point at which an interactive sign-in becomes unavoidable — the shorter-lived
          token behind each session renews itself and is not shown.
        </p>
      </div>
    </PageFrame>
  )
}

// Bigger, panel-specific usage bar (the statusline RateLimitBar is deliberately
// tiny). Full labels, readable percentages, monotonic warm ramp.
function UsageBar({ bucket }: { bucket: UsageBucket }) {
  const clamped = Math.min(100, Math.max(0, bucket.percent))
  const color = clamped >= 90 ? 'var(--color-red)' : clamped >= 70 ? 'var(--color-peach)' : clamped >= 50 ? 'var(--color-yellow)' : 'var(--color-green)'
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-[0.8125rem] text-subtext0 shrink-0" style={{ minWidth: '3.625rem' }}>{bucket.label}</span>
      <span className="flex-1 h-2 rounded-full bg-surface1 overflow-hidden" role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
        <span className="block h-full rounded-full transition-[width] duration-300" style={{ width: `${clamped}%`, backgroundColor: color }} />
      </span>
      <span className="text-[0.8125rem] text-text tabular-nums shrink-0" style={{ minWidth: '2.5rem', textAlign: 'right' }}>{Math.round(clamped)}%</span>
      {bucket.resetsAt && (
        <span className="text-[0.75rem] shrink-0" style={{ color: 'var(--text-muted)' }}>resets {formatResetTime(bucket.resetsAt)}</span>
      )}
    </div>
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
  theme,
  onSignIn,
}: {
  row: AccountUsage
  auth?: ProfileAuthInfo
  theme: 'dark' | 'light'
  onSignIn: () => void
}) {
  const dot = resolveIdentityColor(resolveAccountColourKey(row.email ?? undefined, undefined, undefined), theme)
  // Parked account: undefined active is treated as active (a main process that
  // predates the field never greys a card). Inactive accounts are never network
  // fetched, so they carry no live buckets — the card just states that and
  // offers no sign-in (opening a login shell for an account the user parked
  // bypasses the switcher's own active-guard).
  const isInactive = row.status === 'inactive' || row.active === false
  // Computed at render against the wall clock; the calculation itself is pure and
  // lives in shared/ so main and renderer cannot disagree about what a credential
  // state means.
  const window_ = auth ? describeAuthWindow(auth, Date.now()) : null
  const duplicates = auth?.duplicateOfProfileIds ?? []
  return (
    <div className={`rounded-xl border border-surface0/70 px-4 py-3.5 ${isInactive ? 'bg-surface0/10 opacity-60' : 'bg-surface0/20'}`}>
      <div className="flex items-center gap-2 mb-2.5">
        <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ backgroundColor: dot }} />
        {/* Full email, never truncated (accounts are distinct even when emails look similar). */}
        <span className="text-[0.9375rem] text-text font-medium break-all">{row.email || row.name}</span>
        {row.isPrimary && <span className="text-[0.625rem] text-overlay0 border border-surface1 rounded-full px-1.5 py-px shrink-0">Primary</span>}
        {isInactive && <span className="ml-auto text-[0.625rem] text-overlay0 border border-surface1 rounded-full px-1.5 py-px shrink-0">Inactive</span>}
        {/* A working sign-in gets a refresh too, not just a broken one: the whole
            point is to act BEFORE the forced login, and previously the only way to
            learn it was coming was for it to arrive. Never for a parked account. */}
        {!isInactive && row.status !== 'needs-login' && (
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
        <p className="text-[0.8125rem] text-overlay0">
          Parked — not polled. Reactivate this account in Settings › Accounts to use it again.
        </p>
      )}

      {!isInactive && duplicates.length > 0 && (
        <div className="mb-2.5 px-2.5 py-1.5 rounded-lg bg-red/10 border border-red/25 text-[0.75rem] text-red">
          This profile and {duplicates.length === 1 ? 'another profile' : `${duplicates.length} other profiles`} are
          signed into the SAME account. Each time one refreshes, the others&apos; sign-ins are invalidated — which is
          why they keep expiring. Sign the duplicates in as their own accounts.
        </div>
      )}

      {!isInactive && auth?.identityMismatch && duplicates.length === 0 && (
        <div className="mb-2.5 px-2.5 py-1.5 rounded-lg bg-yellow/10 border border-yellow/25 text-[0.75rem] text-yellow">
          Labelled {auth.accountEmail} but signed in as {auth.oauthEmail}.
        </div>
      )}

      {row.status === 'ok' && row.buckets.length > 0 && (
        <div className="flex flex-col gap-2">
          {row.buckets.map((b) => <UsageBar key={b.key} bucket={b} />)}
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

      {row.status === 'needs-login' && (
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

      {!isInactive && (
        <div className="flex items-center justify-between gap-2 mt-2">
          {row.status === 'ok' ? (
            <p className="text-[0.6875rem] text-overlay0">
              {row.stale ? `Last updated ${relAgo(row.fetchedAt)} · couldn't refresh` : `Updated ${relAgo(row.fetchedAt)}`}
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

function fmtMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

function relAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  return m === 1 ? '1 min ago' : `${m} min ago`
}
