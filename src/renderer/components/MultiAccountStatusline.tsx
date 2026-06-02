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
import type { AccountProfile } from '../../shared/account-types'

export interface LiveAccount {
  email: string
  name: string
  colourKey: IdentityColorKey
  /** worst-case (max) 5h utilisation % across this account's live sessions */
  pct5h: number | null
  /** worst-case (max) 7d utilisation % across this account's live sessions */
  pct7d: number | null
  resets5h?: string
  resets7d?: string
  count: number
  isPrimary: boolean
}

/**
 * Aggregate the live (running) sessions into one entry per distinct account.
 * "Running" = any session still open (excludes `disconnected`/exited). Sessions
 * without a resolved account (shell-only, Codex, not-yet-captured) are skipped.
 * Per account we take the WORST-CASE (max) 5h/7d utilisation so the number is
 * never falsely low when one of an account's sessions has a stale tick. Ordered
 * primary-first, then by name. Pure + unit-tested; the component gates on >=2.
 */
export function liveAccountUsage(
  sessions: Session[],
  profiles: AccountProfile[],
  aliases: Record<string, string> | undefined,
  colourOverrides: Record<string, IdentityColorKey> | undefined,
): LiveAccount[] {
  const primaryEmail = profiles.find((p) => p.isPrimary)?.accountEmail
  const primaryCanon = primaryEmail ? canonicaliseEmail(primaryEmail) : undefined
  const byEmail = new Map<string, LiveAccount>()

  for (const s of sessions) {
    if (s.status === 'disconnected') continue
    if (!s.accountEmail) continue
    const key = canonicaliseEmail(s.accountEmail)
    let acc = byEmail.get(key)
    if (!acc) {
      acc = {
        email: s.accountEmail,
        name: resolveAccountNameByEmail(s.accountEmail, profiles, aliases),
        colourKey: resolveAccountColourKey(s.accountEmail, colourOverrides, s.accountColour),
        pct5h: null,
        pct7d: null,
        count: 0,
        isPrimary: primaryCanon === key,
      }
      byEmail.set(key, acc)
    }
    acc.count++
    if (typeof s.rateLimitCurrent === 'number' && (acc.pct5h === null || s.rateLimitCurrent > acc.pct5h)) {
      acc.pct5h = s.rateLimitCurrent
      acc.resets5h = s.rateLimitCurrentResets
    }
    if (typeof s.rateLimitWeekly === 'number' && (acc.pct7d === null || s.rateLimitWeekly > acc.pct7d)) {
      acc.pct7d = s.rateLimitWeekly
      acc.resets7d = s.rateLimitWeeklyResets
    }
  }

  return Array.from(byEmail.values()).sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function pctText(pct: number | null): string {
  return pct === null ? '—' : `${pct}%`
}

// Muted until it matters, then warning >=70, danger >=90 (mirrors RateLimitBar).
function pctColour(pct: number | null): string {
  if (pct !== null && pct >= 90) return 'var(--status-danger)'
  if (pct !== null && pct >= 70) return 'var(--status-warning)'
  return 'var(--text-muted)'
}

function tooltip(a: LiveAccount): string {
  const lines = [`${a.name} — ${a.count} live session${a.count === 1 ? '' : 's'}`]
  if (a.resets5h) lines.push(`5h resets ${a.resets5h}`)
  if (a.resets7d) lines.push(`7d resets ${a.resets7d}`)
  return lines.join('\n')
}

/**
 * Slim multi-account usage readout for the BottomBar. Only renders when >=2
 * distinct accounts are live, so single-account users see nothing. Reads data
 * already in the session store (statusline-driven) -- no new polling/IPC.
 */
export default function MultiAccountStatusline() {
  const sessions = useSessionStore((s) => s.sessions)
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const aliases = useSettingsStore((s) => s.settings.accountAliases)
  const overrides = useSettingsStore((s) => s.settings.accountColourOverrides)
  const theme = useResolvedTheme()

  const accounts = React.useMemo(
    () => liveAccountUsage(sessions, profiles, aliases, overrides),
    [sessions, profiles, aliases, overrides],
  )

  if (accounts.length < 2) return null

  return (
    <div
      className="flex items-center gap-3 min-w-0 overflow-hidden pl-3 ml-1 border-l"
      style={{ borderColor: 'var(--border-subtle)' }}
      data-testid="multi-account-statusline"
    >
      {accounts.map((a) => (
        <span key={a.email} className="flex items-center gap-1.5 shrink-0" title={tooltip(a)}>
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: resolveIdentityColor(a.colourKey, theme) }}
          />
          <span className="font-medium truncate max-w-[120px]" style={{ color: 'var(--text-on-chrome)' }}>
            {a.name}
          </span>
          <span className="tabular-nums">
            <span style={{ color: 'var(--text-muted)' }}>5h </span>
            <span style={{ color: pctColour(a.pct5h) }}>{pctText(a.pct5h)}</span>
            <span style={{ color: 'var(--text-muted)' }}> · 7d </span>
            <span style={{ color: pctColour(a.pct7d) }}>{pctText(a.pct7d)}</span>
          </span>
        </span>
      ))}
    </div>
  )
}
