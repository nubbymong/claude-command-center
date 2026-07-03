import React, { useEffect, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import RateLimitBar from './terminal/RateLimitBar'
import { useReauthAccount } from '../hooks/useReauthAccount'
import { resolveAccountColourKey, middleTruncateEmail } from '../../shared/account-chip-color'
import { resolveIdentityColor } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import type { AccountUsage } from '../../shared/usage-types'

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
        className="h-full w-[420px] max-w-[92vw] bg-mantle border-l border-surface0 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-surface0 shrink-0">
          <h3 className="text-sm font-semibold text-text">Account usage</h3>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void load()}
              className="text-[11px] px-2 py-1 rounded text-overlay1 hover:text-text hover:bg-surface0 transition-colors"
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
          {loading && !rows && <p className="text-xs text-overlay0">Loading usage for all accounts…</p>}
          {rows && rows.length === 0 && <p className="text-xs text-overlay0">No accounts found.</p>}
          {rows?.map((row) => (
            <AccountCard key={row.profileId} row={row} theme={theme} onSignIn={() => onSignIn(row)} />
          ))}
          <p className="text-[10px] text-overlay0 leading-relaxed pt-1">
            Usage is read live from each account, no session required. An account whose sign-in has expired shows a
            Sign in button; signing in refreshes only that account.
          </p>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function AccountCard({ row, theme, onSignIn }: { row: AccountUsage; theme: 'dark' | 'light'; onSignIn: () => void }) {
  const dot = resolveIdentityColor(resolveAccountColourKey(row.email ?? undefined, undefined, undefined), theme)
  return (
    <div className="rounded-xl border border-surface0/70 bg-surface0/20 px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="w-2 h-2 rounded-[2px] shrink-0" style={{ backgroundColor: dot }} />
        <span className="text-xs text-text font-medium truncate">{row.email ? middleTruncateEmail(row.email) : row.name}</span>
        {row.isPrimary && <span className="text-[9px] text-overlay0 border border-surface1 rounded-full px-1.5">Primary</span>}
      </div>

      {row.status === 'ok' && row.buckets.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {row.buckets.map((b) => (
            <RateLimitBar key={b.key} label={b.label} pct={b.percent} resets={b.resetsAt || undefined} showReset />
          ))}
          {row.credits && (
            <div className="flex items-center justify-between text-[11px] mt-1 pt-1.5 border-t border-surface0/60">
              <span className="text-overlay1">Credits</span>
              <span className="text-text tabular-nums">
                {row.credits.remaining != null
                  ? `${fmtMoney(row.credits.remaining, row.credits.currency)} left`
                  : `${fmtMoney(row.credits.used, row.credits.currency)} used`}
              </span>
            </div>
          )}
        </div>
      )}

      {row.status === 'ok' && row.buckets.length === 0 && (
        <p className="text-[11px] text-overlay0">No usage limits reported.</p>
      )}

      {row.status === 'needs-login' && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-overlay0">{row.detail === 'session expired' ? 'Sign-in expired' : 'Not signed in'}</span>
          <button
            onClick={onSignIn}
            className="text-[11px] px-2.5 py-1 rounded bg-blue text-crust font-medium hover:bg-blue/90 transition-colors shrink-0"
          >
            Sign in
          </button>
        </div>
      )}

      {row.status === 'error' && (
        <p className="text-[11px] text-overlay0">Couldn&apos;t load usage{row.detail ? ` (${row.detail})` : ''}.</p>
      )}

      {row.status === 'ok' && (
        <p className="text-[10px] text-overlay0 mt-1.5">Updated {relAgo(row.fetchedAt)}</p>
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
