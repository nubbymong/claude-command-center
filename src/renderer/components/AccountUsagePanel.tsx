import React, { useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useReauthAccount } from '../hooks/useReauthAccount'
import { resolveAccountColourKey } from '../../shared/account-chip-color'
import { resolveIdentityColor } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import { formatResetTime } from '../utils/terminalFormatting'
import type { AccountUsage, UsageBucket } from '../../shared/usage-types'

// All-accounts usage overview (person icon in the title bar, shown only with
// 2+ accounts). Fetches each account's usage directly — no session needed —
// and offers a per-card "Sign in" for accounts whose token has expired.
export default function AccountUsagePanel({ onClose, onReauthNavigate }: {
  onClose: () => void
  /** Switch the app to the sessions view so the user sees the login shell. */
  onReauthNavigate: () => void
}) {
  const theme = useResolvedTheme()
  const reauth = useReauthAccount()
  const [rows, setRows] = useState<AccountUsage[] | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await window.electronAPI.accountUsage.fetchAll()
      setRows(data)
    } catch {
      setRows([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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

  return createPortal(
    <div className="fixed inset-0 z-[70] flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="h-full w-[480px] max-w-[94vw] bg-mantle border-l border-surface0 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-surface0 shrink-0">
          <h3 className="text-base font-semibold text-text">Account usage</h3>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void load()}
              className="text-[13px] px-2.5 py-1 rounded text-overlay1 hover:text-text hover:bg-surface0 transition-colors"
              title="Refresh all"
            >
              Refresh
            </button>
            <button onClick={onClose} className="p-1 rounded text-overlay1 hover:text-text hover:bg-surface0 transition-colors" aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3"><line x1="3" y1="3" x2="11" y2="11" /><line x1="11" y1="3" x2="3" y2="11" /></svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading && !rows && <p className="text-[13px] text-overlay0">Loading usage for all accounts…</p>}
          {rows && rows.length === 0 && <p className="text-[13px] text-overlay0">No accounts found.</p>}
          {rows?.map((row) => (
            <AccountCard key={row.profileId} row={row} theme={theme} onSignIn={() => onSignIn(row)} />
          ))}
          <p className="text-[11px] text-overlay0 leading-relaxed pt-1">
            Usage is read live from each account, no session required. An account whose sign-in has expired shows a
            Sign in button; signing in refreshes only that account.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

// Bigger, panel-specific usage bar (the statusline RateLimitBar is deliberately
// tiny). Full labels, readable percentages, monotonic warm ramp.
function UsageBar({ bucket }: { bucket: UsageBucket }) {
  const clamped = Math.min(100, Math.max(0, bucket.percent))
  const color = clamped >= 90 ? 'var(--color-red)' : clamped >= 70 ? 'var(--color-peach)' : clamped >= 50 ? 'var(--color-yellow)' : 'var(--color-green)'
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-[13px] text-subtext0 shrink-0" style={{ minWidth: 58 }}>{bucket.label}</span>
      <span className="flex-1 h-2 rounded-full bg-surface1 overflow-hidden" role="progressbar" aria-valuenow={clamped} aria-valuemin={0} aria-valuemax={100}>
        <span className="block h-full rounded-full transition-[width] duration-300" style={{ width: `${clamped}%`, backgroundColor: color }} />
      </span>
      <span className="text-[13px] text-text tabular-nums shrink-0" style={{ minWidth: 40, textAlign: 'right' }}>{Math.round(clamped)}%</span>
      {bucket.resetsAt && (
        <span className="text-[12px] shrink-0" style={{ color: 'var(--text-muted)' }}>resets {formatResetTime(bucket.resetsAt)}</span>
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

function AccountCard({ row, theme, onSignIn }: { row: AccountUsage; theme: 'dark' | 'light'; onSignIn: () => void }) {
  const dot = resolveIdentityColor(resolveAccountColourKey(row.email ?? undefined, undefined, undefined), theme)
  return (
    <div className="rounded-xl border border-surface0/70 bg-surface0/20 px-4 py-3.5">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ backgroundColor: dot }} />
        {/* Full email, never truncated (accounts are distinct even when emails look similar). */}
        <span className="text-[15px] text-text font-medium break-all">{row.email || row.name}</span>
        {row.isPrimary && <span className="text-[10px] text-overlay0 border border-surface1 rounded-full px-1.5 py-px shrink-0">Primary</span>}
      </div>

      {row.status === 'ok' && row.buckets.length > 0 && (
        <div className="flex flex-col gap-2">
          {row.buckets.map((b) => <UsageBar key={b.key} bucket={b} />)}
          {row.credits && (
            <div className="flex items-center justify-between text-[13px] mt-1 pt-2 border-t border-surface0/60">
              <span className="text-overlay1">Credits</span>
              <span className={`tabular-nums ${row.credits.enabled ? 'text-text' : 'text-overlay1'}`}>{creditsText(row.credits)}</span>
            </div>
          )}
        </div>
      )}

      {row.status === 'ok' && row.buckets.length === 0 && (
        <p className="text-[13px] text-overlay0">No usage limits reported.</p>
      )}

      {row.status === 'needs-login' && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] text-overlay0">{row.detail === 'session expired' ? 'Sign-in expired' : 'Not signed in'}</span>
          <button
            onClick={onSignIn}
            className="text-[13px] px-3 py-1.5 rounded-lg bg-blue text-crust font-medium hover:bg-blue/90 transition-colors shrink-0"
          >
            Sign in
          </button>
        </div>
      )}

      {row.status === 'error' && (
        <p className="text-[13px] text-overlay0">Couldn&apos;t load usage{row.detail ? ` (${row.detail})` : ''}.</p>
      )}

      {row.status === 'ok' && (
        <p className="text-[11px] text-overlay0 mt-2">Updated {relAgo(row.fetchedAt)}</p>
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
