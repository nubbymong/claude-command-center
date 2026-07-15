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
import RateLimitBar from './terminal/RateLimitBar'
import type { AccountProfile } from '../../shared/account-types'
import type { UsageBucket } from '../../shared/usage-types'

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

/**
 * Aggregate the live (running) sessions into one entry per distinct account.
 * "Running" = any session still open (excludes `disconnected`/exited). Sessions
 * without a resolved account (shell-only, Codex, not-yet-captured) are skipped.
 * Per account, per bucket label, we take the WORST-CASE (max) utilisation so the
 * number is never falsely low when one of an account's sessions has a stale tick.
 * Ordered primary-first, then by name. Pure + unit-tested; the component gates on >=2.
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
  // email -> (bucket label -> worst-case bucket). Map preserves first-seen order
  // so the rendered bars keep the API's order (5h, Weekly, then per-model).
  const bucketsByEmail = new Map<string, Map<string, UsageBucket>>()

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
        buckets: [],
        count: 0,
        isPrimary: primaryCanon === key,
      }
      byEmail.set(key, acc)
      bucketsByEmail.set(key, new Map())
    }
    acc.count++
    const lblMap = bucketsByEmail.get(key)!
    for (const b of sessionUsageBuckets(s)) {
      const prev = lblMap.get(b.label)
      if (!prev || b.percent > prev.percent) lblMap.set(b.label, b)
    }
  }

  for (const [key, acc] of byEmail) {
    acc.buckets = Array.from(bucketsByEmail.get(key)!.values())
  }

  return Array.from(byEmail.values()).sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function tooltip(a: LiveAccount): string {
  const lines = [`${a.name} — ${a.count} live session${a.count === 1 ? '' : 's'}`]
  for (const b of a.buckets) if (b.resetsAt) lines.push(`${b.label} resets ${b.resetsAt}`)
  return lines.join('\n')
}

/**
 * Slim multi-account usage readout for the BottomBar. Only renders when >=2
 * distinct accounts are live, so single-account users see nothing. Reads data
 * already in the session store (statusline-driven) -- no new polling/IPC. Which
 * bars appear is curated INDEPENDENTLY of the per-session strip via
 * footerHiddenUsageBuckets (a footer-scoped denylist by bucket label).
 */
export default function MultiAccountStatusline() {
  const sessions = useSessionStore((s) => s.sessions)
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const aliases = useSettingsStore((s) => s.settings.accountAliases)
  const overrides = useSettingsStore((s) => s.settings.accountColourOverrides)
  const hidden = useSettingsStore((s) => s.settings.footerHiddenUsageBuckets) ?? EMPTY_HIDDEN
  const theme = useResolvedTheme()

  const accounts = React.useMemo(
    () => liveAccountUsage(sessions, profiles, aliases, overrides),
    [sessions, profiles, aliases, overrides],
  )

  if (accounts.length < 2) return null

  // Bug 3: per account show the FULL email + the real statusline progress bars
  // (RateLimitBar, same as SessionStatusStrip). BottomBar centres this cluster
  // along the footer. The footer-scoped denylist filters which bars show here,
  // so the user can e.g. keep only Fable in the footer to narrow the cluster.
  return (
    <div
      className="flex items-center gap-6 min-w-0"
      data-testid="multi-account-statusline"
    >
      {accounts.map((a) => {
        const shown = a.buckets.filter((b) => !hidden.includes(b.label))
        return (
          <span key={a.email} className="flex items-center gap-2 shrink-0" title={tooltip(a)}>
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ background: resolveIdentityColor(a.colourKey, theme) }}
            />
            <span className="font-medium" style={{ color: 'var(--text-on-chrome)' }}>
              {a.email}
            </span>
            {shown.map((b) => (
              <RateLimitBar key={b.key} label={b.label} pct={b.percent} resets={b.resetsAt || undefined} />
            ))}
          </span>
        )
      })}
    </div>
  )
}
