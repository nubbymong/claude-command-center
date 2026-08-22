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
import RateLimitBar, { RateLimitBarPending } from './terminal/RateLimitBar'
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
 *  + two meters) is already the most that fits to the right of the runtime band
 *  at the 1280px minimum window width (src/main/index.ts minWidth). */
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

function tooltip(a: LiveAccount, opts?: { withPercent?: boolean }): string {
  const lines = [`${a.name} — ${a.count} live session${a.count === 1 ? '' : 's'}`]
  // The email can be ellipsised in the two-row layout, so keep it in the
  // tooltip -- the account is otherwise unidentifiable when it is clipped.
  if (a.name !== a.email) lines.push(a.email)
  for (const b of a.buckets) {
    // In minimal mode the dots carry a BAND, not a figure, so the exact number
    // has nowhere else to live and the tooltip is the whole readout rather than
    // a supplement to a visible bar.
    const parts = [b.label]
    if (opts?.withPercent) parts.push(`${Math.round(b.percent)}%`)
    if (b.resetsAt) parts.push(`resets ${b.resetsAt}`)
    if (parts.length > 1) lines.push(parts.join(' — '))
  }
  return lines.join('\n')
}

function shownBuckets(a: LiveAccount, hidden: string[]): UsageBucket[] {
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
export function summariseAccountDots(a: LiveAccount, hidden: string[]): AccountDotSummary {
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
  showPending,
  minimal,
}: {
  account: LiveAccount
  hidden: string[]
  theme: 'dark' | 'light'
  compact: boolean
  /** Whether a payload is still expected -- see the gate in the parent. */
  showPending: boolean
  /** Minimal mode: the meters collapse to traffic-light dots and the label
   *  becomes the account's NAME, which is the friendly name when one is set and
   *  the full email when it is not. */
  minimal: boolean
}) {
  // The pill is tinted with the account's OWN identity colour, so the rim ties
  // the row to the account instead of drawing a neutral box around it.
  //
  // There is no dot any more (user call 2026-08-21: "we dont need the account
  // colour dot as well as the pill colour"). The rim, the fill and the dot were
  // three statements of one fact, and the dot was the one costing horizontal
  // room in the tightest bar in the app. The overflow list KEEPS its dot —
  // those rows carry no pill tint, so there the dot is the only identity signal
  // rather than the third.
  //
  // It previously asked for `var(--surface1)`, which does not exist: the token
  // is `--color-surface1`. An undefined custom property makes `border-color`
  // invalid, so it fell back to `currentColor` and the rim was drawn in the
  // TEXT colour — a near-white outline on the chrome — and the `color-mix()`
  // background silently dropped, leaving no fill at all.
  const accent = resolveIdentityColor(account.colourKey, theme)
  const shown = shownBuckets(account, hidden)
  const dots = summariseAccountDots(account, hidden)
  // "Nothing to show" has two causes and they need opposite treatments:
  // nothing has been REPORTED yet (waiting -- shimmer), or the user has hidden
  // every bucket for the footer (their choice -- show nothing). Keying the
  // placeholder off `shown` conflated them and overrode the setting with a
  // shimmer that never resolves. Key it off the raw buckets instead.
  const reportedNothing = account.buckets.length === 0
  return (
    <span
      // Each account sits in its own subtle rounded pill so the boundary between
      // accounts reads at a glance, rather than relying on whitespace alone.
      className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${compact ? 'min-w-0' : 'shrink-0'}`}
      style={{
        // Softer than it was (38/9): with the dot gone the rim is no longer
        // competing with a saturated disc beside it, so it can do the job at
        // lower intensity. The bar carries one of these per account and they
        // were shouting over the meters they exist to frame.
        borderColor: `color-mix(in srgb, ${accent} 26%, transparent)`,
        background: `color-mix(in srgb, ${accent} 6%, transparent)`,
      }}
      title={tooltip(account, { withPercent: minimal })}
      data-testid="multi-account-pill"
      data-minimal={minimal ? 'true' : undefined}
    >
      <span
        className={`font-medium ${compact ? 'truncate' : ''}`}
        style={{ color: 'var(--text-on-chrome)' }}
        data-testid="multi-account-pill-label"
      >
        {minimal ? account.name : account.email}
      </span>
      {/* Meters never shrink -- the email is what gives way when space is tight.
          COMPACT here: short codes and no trailing percentage. With four accounts
          on the strip the words and numbers repeated twelve times and crowded out
          the bars, which are the part you actually read. The exact figure is in
          each bar's tooltip, and the "+N" popover below stays fully labelled --
          glanceable strip, detailed popover. */}
      <span className={`flex items-center shrink-0 ${minimal ? 'gap-1.5' : 'gap-2'}`}>
        {minimal && shown.length > 0
          ? // Usage first, then a dot per model, matching the order the meters
            // were in. B1: bare dots, no keys -- the labelled variant was measured
            // wider than the meters saved and cost minimal mode its single row.
            <>
              {dots.usage && (
                <UsageDot
                  rag={ragFor(dots.usage.worst.percent)}
                  title={dots.usage.windows.map((b) => `${b.label} ${Math.round(b.percent)}%`).join(' · ')}
                  label={`Usage ${RAG_WORD[ragFor(dots.usage.worst.percent)]} — worst is ${dots.usage.worst.label} at ${Math.round(dots.usage.worst.percent)}%`}
                />
              )}
              {dots.models.map((b) => (
                <UsageDot
                  key={b.key}
                  rag={ragFor(b.percent)}
                  title={`${b.label} ${Math.round(b.percent)}%`}
                  label={`${b.label} ${RAG_WORD[ragFor(b.percent)]} at ${Math.round(b.percent)}%`}
                />
              ))}
            </>
          : shown.length > 0
          ? shown.map((b) => (
              <RateLimitBar key={b.key} label={b.label} pct={b.percent} resets={b.resetsAt || undefined} compact />
            ))
          : // The account is live but its statusline has not reported yet. An
            // account with no meters at all reads as an account with no usage,
            // which is the opposite of the truth on a fresh session.
            //
            // Only when a payload is actually coming: something must still be
            // unreported, and the status line must be on. With the switch off,
            // or with every bucket hidden by choice, nothing will ever replace
            // the shimmer -- and one that never resolves is worse than blank.
            reportedNothing &&
            showPending &&
            (minimal
              ? // One neutral placeholder, NOT a green dot. Green is a claim that
                // the account has room; nothing has been reported, so the honest
                // signal is "waiting" -- same reasoning as the pending meter,
                // which shows no colour and no number until there is one.
                <PendingDot />
              : PENDING_FOOTER_LABELS.filter((l) => !hidden.includes(l)).map((l) => (
                  <RateLimitBarPending key={l} label={l} compact />
                )))}
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
  // Master status-line switch, same flag the session strip gates on. It does NOT
  // gate the live bars here (the footer has always shown whatever the store
  // holds); it gates only the PENDING placeholder, which is a promise that data
  // is on its way. With the switch off that promise is false. Absent
  // (pre-upgrade config) means on.
  const statusLineEnabled = useSettingsStore((s) => s.settings.statusLineEnabled ?? true)
  // Absent means the meters, so nobody's footer changes shape on upgrade.
  const minimal = useSettingsStore((s) => s.settings.footerAccountDisplay === 'dots')
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
          // flex-wrap is the occlusion fix. The count-based split above caps a
          // row at 3 accounts, but 3 pills still overflow a narrow window --
          // and the centred cluster then spilled equally out of BOTH sides of
          // its zone and was clipped by the footer's overflow-hidden, cutting
          // the first pill in half against the CLI band. Wrapping turns that
          // horizontal overflow into an extra line, which the footer can absorb
          // because its height is a MINIMUM (min-h-7), not a fixed size.
          className={`flex flex-wrap items-center justify-center min-w-0 ${multiRow ? 'gap-x-2 gap-y-1' : 'gap-x-3 gap-y-1'}`}
          data-testid="multi-account-row"
        >
          {row.map((a) => (
            <AccountPill key={a.email} account={a} hidden={hidden} theme={theme} compact={multiRow} showPending={statusLineEnabled} minimal={minimal} />
          ))}
          {i === rows.length - 1 && overflow.length > 0 && (
            <AccountOverflow accounts={overflow} hidden={hidden} theme={theme} />
          )}
        </div>
      ))}
    </div>
  )
}
