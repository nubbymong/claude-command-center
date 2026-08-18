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

/** Never more than 3 account pills side by side -- three full pills (dot + email
 *  + two meters) is already the most that fits between the runtime band and the
 *  disclaimer at the 1280px minimum window width (src/main/index.ts minWidth). */
export const FOOTER_MAX_PER_ROW = 3
/** The footer grows to at most two rows; past that the tail goes behind the
 *  overflow control rather than eating more of the terminal's height. */
export const FOOTER_MAX_ROWS = 2
export const FOOTER_MAX_VISIBLE = FOOTER_MAX_PER_ROW * FOOTER_MAX_ROWS

export interface FooterRowLayout<T> {
  /** Rendered rows, in order. 1 row for <=3 accounts, else 2. */
  rows: T[][]
  /** Everything past FOOTER_MAX_VISIBLE -- shown via the "+N" overflow control. */
  overflow: T[]
}

/**
 * Split the live accounts into footer rows.
 *
 *   <=3  -> a single row (byte-identical layout to the pre-two-row footer)
 *   4..6 -> two rows, BALANCED (4 -> 2+2, 5 -> 3+2, 6 -> 3+3). Balanced rather
 *           than fill-first (3+1) so the centred cluster stays symmetric; both
 *           satisfy the "max 3 per row" rule.
 *   >6   -> the first 6 in two rows of 3, the rest returned as `overflow`.
 *
 * Pure and generic so the boundaries are unit-testable without a DOM.
 */
export function splitAccountRows<T>(accounts: T[]): FooterRowLayout<T> {
  const visible = accounts.slice(0, FOOTER_MAX_VISIBLE)
  const overflow = accounts.slice(FOOTER_MAX_VISIBLE)
  if (visible.length === 0) return { rows: [], overflow }
  if (visible.length <= FOOTER_MAX_PER_ROW) return { rows: [visible], overflow }
  const perRow = Math.min(FOOTER_MAX_PER_ROW, Math.ceil(visible.length / FOOTER_MAX_ROWS))
  const rows: T[][] = []
  for (let i = 0; i < visible.length; i += perRow) rows.push(visible.slice(i, i + perRow))
  return { rows, overflow }
}

function tooltip(a: LiveAccount): string {
  const lines = [`${a.name} — ${a.count} live session${a.count === 1 ? '' : 's'}`]
  // The email can be ellipsised in the two-row layout, so keep it in the
  // tooltip -- the account is otherwise unidentifiable when it is clipped.
  if (a.name !== a.email) lines.push(a.email)
  for (const b of a.buckets) if (b.resetsAt) lines.push(`${b.label} resets ${b.resetsAt}`)
  return lines.join('\n')
}

function shownBuckets(a: LiveAccount, hidden: string[]): UsageBucket[] {
  return a.buckets.filter((b) => !hidden.includes(b.label))
}

/**
 * One account: identity dot + full email + its meters. `compact` is the two-row
 * layout -- the pill may shrink and the email ellipsises (tooltip keeps it), so
 * three pills survive a narrow window. Single-row keeps `shrink-0` + the full
 * email, i.e. exactly the pre-two-row rendering.
 */
function AccountPill({
  account,
  hidden,
  theme,
  compact,
}: {
  account: LiveAccount
  hidden: string[]
  theme: 'dark' | 'light'
  compact: boolean
}) {
  return (
    <span
      // Each account sits in its own subtle rounded pill so the boundary between
      // accounts reads at a glance, rather than relying on whitespace alone.
      className={`flex items-center gap-2 rounded-full border px-2.5 py-0.5 ${compact ? 'min-w-0' : 'shrink-0'}`}
      style={{ borderColor: 'var(--surface1)', background: 'color-mix(in srgb, var(--surface1) 22%, transparent)' }}
      title={tooltip(account)}
      data-testid="multi-account-pill"
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ background: resolveIdentityColor(account.colourKey, theme) }}
      />
      <span
        className={`font-medium ${compact ? 'truncate' : ''}`}
        style={{ color: 'var(--text-on-chrome)' }}
      >
        {account.email}
      </span>
      {/* Meters never shrink -- the email is what gives way when space is tight. */}
      <span className="flex items-center gap-2 shrink-0">
        {shownBuckets(account, hidden).map((b) => (
          <RateLimitBar key={b.key} label={b.label} pct={b.percent} resets={b.resetsAt || undefined} />
        ))}
      </span>
    </span>
  )
}

const OVERFLOW_POPOVER_W = 320

/**
 * "+N" control for the accounts past the two rows. Opens a small popover with
 * the same dot/email/meters, one per line.
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
function AccountOverflow({
  accounts,
  hidden,
  theme,
}: {
  accounts: LiveAccount[]
  hidden: string[]
  theme: 'dark' | 'light'
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

  const label = `${accounts.length} more account${accounts.length === 1 ? '' : 's'}`

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
              key={a.email}
              className="flex flex-col gap-1 min-w-0"
              data-testid="multi-account-overflow-row"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: resolveIdentityColor(a.colourKey, theme) }}
                />
                <span className="font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {a.email}
                </span>
                <span
                  className="ml-auto shrink-0 tabular-nums text-[10px]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {a.count} live
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2 pl-4">
                {shownBuckets(a, hidden).map((b) => (
                  <RateLimitBar key={b.key} label={b.label} pct={b.percent} resets={b.resetsAt || undefined} />
                ))}
              </span>
            </div>
          ))}
        </div>
      )}
    </span>
  )
}

/**
 * Slim multi-account usage readout for the BottomBar. Only renders when >=2
 * distinct accounts are live, so single-account users see nothing. Reads data
 * already in the session store (statusline-driven) -- no new polling/IPC. Which
 * bars appear is curated INDEPENDENTLY of the per-session strip via
 * footerHiddenUsageBuckets (a footer-scoped denylist by bucket label).
 *
 * Layout (owner request): <=3 accounts stay on one row exactly as before; 4-6
 * stretch the footer to two rows of at most 3; past 6 the tail collapses into a
 * "+N" overflow control. The footer is `min-h-7` (a MINIMUM) inside a flex
 * column whose terminal pane re-fits from a ResizeObserver, so growing it is
 * safe -- nothing measures the bar's height.
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

  const { rows, overflow } = React.useMemo(() => splitAccountRows(accounts), [accounts])

  if (accounts.length < 2) return null

  // Bug 3: per account show the FULL email + the real statusline progress bars
  // (RateLimitBar, same as SessionStatusStrip). BottomBar centres this cluster
  // along the footer. The footer-scoped denylist filters which bars show here,
  // so the user can e.g. keep only Fable in the footer to narrow the cluster.
  const multiRow = rows.length > 1

  return (
    <div
      className={`flex flex-col items-center min-w-0 ${multiRow ? 'gap-1 py-1' : ''}`}
      data-testid="multi-account-statusline"
      data-account-rows={rows.length}
    >
      {rows.map((row, i) => (
        <div
          key={i}
          className={`flex items-center justify-center min-w-0 ${multiRow ? 'gap-2' : 'gap-3'}`}
          data-testid="multi-account-row"
        >
          {row.map((a) => (
            <AccountPill key={a.email} account={a} hidden={hidden} theme={theme} compact={multiRow} />
          ))}
          {i === rows.length - 1 && overflow.length > 0 && (
            <AccountOverflow accounts={overflow} hidden={hidden} theme={theme} />
          )}
        </div>
      ))}
    </div>
  )
}
