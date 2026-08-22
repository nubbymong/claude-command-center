import React, { useEffect, useRef, useState } from 'react'
import { useGitHubStore } from '../stores/githubStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore, type Session } from '../stores/sessionStore'
import { formatCredits, formatBilledUsd, selectUsagePool } from '../lib/ai-usage-format'
import { formatResetTime } from '../utils/terminalFormatting'
import { DialogButton } from './ui/Dialog'

// No \u{...} escapes in JSX (esbuild). U+21BB CLOCKWISE OPEN CIRCLE ARROW.
const REFRESH_GLYPH = String.fromCodePoint(0x21bb)

// #360: the popover is anchored chrome, not a modal, so it keeps its own
// positioning and its `role="dialog"` host element — only the colours move onto
// the semantic tokens. Its inner section cards are sunken wells inside the
// raised popover frame.
const CARD_CLASS = 'rounded border p-2.5'
const CARD_STYLE: React.CSSProperties = {
  borderColor: 'var(--border-subtle)',
  background: 'var(--surface-sunken)',
}
/** A quiet inline text link ("Open Settings", "Copilot meter settings"). */
const LINK_CLASS =
  'text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors focus-ring'

function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

// A 5h / 7d rate-limit window pair, read from a session's statusline telemetry.
// Shared by the Codex and Claude provider sections so both render identically.
function RateWindows({ session }: { session: Session | null }) {
  if (!session || session.rateLimitCurrent == null) {
    return (
      <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
        no session telemetry this run
      </div>
    )
  }
  return (
    <div
      className="flex flex-col gap-1 text-[11px] tabular-nums"
      style={{ color: 'var(--text-secondary)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <span>
          5h window{' '}
          <span style={{ color: 'var(--text-primary)' }}>{Math.round(session.rateLimitCurrent)}%</span>
        </span>
        {session.rateLimitCurrentResets && (
          <span style={{ color: 'var(--text-muted)' }}>
            resets {formatResetTime(session.rateLimitCurrentResets)}
          </span>
        )}
      </div>
      {session.rateLimitWeekly != null && (
        <div className="flex items-center justify-between gap-2">
          <span>
            7d window{' '}
            <span style={{ color: 'var(--text-primary)' }}>{Math.round(session.rateLimitWeekly)}%</span>
          </span>
          {session.rateLimitWeeklyResets && (
            <span style={{ color: 'var(--text-muted)' }}>
              resets {formatResetTime(session.rateLimitWeeklyResets)}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function SectionHeader({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5">
      <span className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>
        {title}
      </span>
      {note && (
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          {note}
        </span>
      )}
    </div>
  )
}

/**
 * Unified, READ-only usage popover anchored under the repo-strip AI chip.
 * Three provider sections:
 *   - GitHub  : per-model rows from aiUsage (gross credits / covered / billed),
 *               a totals row, and a cap bar when copilotIncludedCredits is set.
 *   - Codex   : the active/most-recent Codex session's statusline rate-limit
 *               windows (5h / 7d), already captured per session.
 *   - Claude  : the active Claude session's statusline rate-limit windows.
 * A Refresh button re-pulls GitHub usage. No settings live here; a quiet link
 * points at Settings for the cap.
 */
// Thin gate with NO hooks: while closed, the body (and its session-store
// subscription, which ticks with telemetry ~1-3x/s) is fully unmounted — the
// chip subtree must not undo App.tsx's structuralSessionsEqual isolation just
// by existing (review nit on cd96a71). Costs the leave animation nothing:
// the previous inline `if (!open) return null` already skipped it.
export default function AiUsagePopover(props: {
  open: boolean
  onClose: () => void
  onOpenSettings?: (tab?: 'github' | 'statusline') => void
}) {
  if (!props.open) return null
  return <AiUsagePopoverBody {...props} />
}

function AiUsagePopoverBody({
  open,
  onClose,
  onOpenSettings,
}: {
  open: boolean
  onClose: () => void
  onOpenSettings?: (tab?: 'github' | 'statusline') => void
}) {
  const aiUsage = useGitHubStore((s) => s.aiUsage)
  const aiUsageStatus = useGitHubStore((s) => s.aiUsageStatus)
  const aiUsageCycle = useGitHubStore((s) => s.aiUsageCycle)
  const loadAiUsage = useGitHubStore((s) => s.loadAiUsage)
  const cap = useSettingsStore((s) => s.settings.copilotIncludedCredits)
  const planName = useSettingsStore((s) => s.settings.copilotPlanName)
  const sessions = useSessionStore((s) => s.sessions)
  const activeSessionId = useSessionStore((s) => s.activeSessionId)

  const [entered, setEntered] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Drive enter/leave off `open` (mirrors ConductorServicesPanel): the parent
  // keeps us mounted ~200ms after open flips false so the leave animation runs.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => setEntered(true), 0)
      return () => clearTimeout(t)
    }
    setEntered(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      // The chip owns its own toggle; ignore clicks on it so the toggle isn't
      // fought by this close-on-outside handler.
      if (target.closest?.('[data-ai-usage-chip]')) return
      if (ref.current && !ref.current.contains(target)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open, onClose])

  // Provider session sourcing. Claude = the active session when it is a Claude
  // session, else the most-recent Claude session. Codex = the active session
  // when it is Codex, else the most-recent Codex session. "Most-recent" is the
  // highest createdAt so a just-spawned session wins, matching what the user is
  // looking at. Both fall back to a quiet "no session this run" line.
  const active = sessions.find((s) => s.id === activeSessionId) || null
  const byRecency = [...sessions].sort((a, b) => b.createdAt - a.createdAt)
  const isCodex = (s: Session) => (s.provider ?? 'claude') === 'codex'
  const claudeSession =
    (active && !isCodex(active) ? active : null) || byRecency.find((s) => !isCodex(s)) || null
  const codexSession =
    (active && isCodex(active) ? active : null) || byRecency.find(isCodex) || null

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      // force: bypass the main-process cache so Refresh actually re-pulls usage
      // (and recomputes the cycle figure) instead of echoing the cached report.
      await loadAiUsage(true)
    } finally {
      setRefreshing(false)
    }
  }

  const capSet = cap != null && cap > 0
  const totalGrossCredits = aiUsage
    ? aiUsage.items.reduce((sum, it) => sum + it.grossQuantity, 0)
    : 0
  // Cycle-preferred included-credit pool drives the primary progress bar. When
  // aiUsage is null the placeholder branch renders, so a zero pool is harmless.
  const pool = aiUsage
    ? selectUsagePool(aiUsage, cap, aiUsageCycle)
    : { used: 0, billed: 0, pct: 0, over: false, capSet, priorPlanBilled: 0 }
  const headerNote = [
    planName || null,
    aiUsage ? `as of ${formatResetTime(new Date(aiUsage.fetchedAt).toISOString())}` : null,
  ]
    .filter(Boolean)
    .join(' · ') || undefined

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="AI usage"
      className={`absolute right-0 top-full mt-1.5 z-50 w-80 rounded-lg border shadow-xl p-3 flex flex-col gap-3 transition-all duration-200 ease-out ${
        entered ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1'
      }`}
      style={{
        background: 'var(--surface-raised)',
        borderColor: 'var(--border-subtle)',
        color: 'var(--text-primary)',
      }}
    >
      {/* GitHub section */}
      <div className={CARD_CLASS} style={CARD_STYLE}>
        <SectionHeader title="GitHub Copilot" note={headerNote} />
        {!aiUsage ? (
          <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
            {aiUsageStatus === 'no-auth' ? (
              <>
                Connect a GitHub account in Settings, then this meter reads your billed
                AI-credit usage.
              </>
            ) : aiUsageStatus === 'scope-missing' ? (
              <>
                The GitHub token is missing the billing permission. Add the{' '}
                <code style={{ color: 'var(--text-muted)' }}>user</code> scope (classic) or Account
                permissions <span style={{ color: 'var(--text-muted)' }}>Plan: read</span>{' '}
                (fine-grained) in Settings.
              </>
            ) : aiUsageStatus === 'error' ? (
              <>Couldn&apos;t reach GitHub for your usage. It will retry on the next refresh.</>
            ) : (
              <>
                No data yet. Usage refreshes hourly once a token with billing scope is
                configured.
              </>
            )}
            <button
              onClick={() => onOpenSettings?.('github')}
              className={`mt-1.5 block self-start text-[10px] underline decoration-dotted ${LINK_CLASS}`}
            >
              Open Settings
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-[11px] tabular-nums">
            {/* PRIMARY: the included-credit pool (cycle-scoped when configured,
                matching GitHub's billing card). This is the headline number. */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[10px]">
                <span style={{ color: 'var(--text-secondary)' }}>
                  {aiUsageCycle ? 'Included AI credits' : 'Credits this month'}
                  {aiUsageCycle && (
                    <span style={{ color: 'var(--text-muted)' }}> since {aiUsageCycle.since}</span>
                  )}
                </span>
                <span
                  className="font-medium"
                  style={{ color: pool.over ? 'var(--status-warning)' : 'var(--text-primary)' }}
                >
                  {formatCredits(pool.used)}
                  {capSet && ` / ${formatCredits(cap as number)}`}
                  {capSet && (
                    <span style={{ color: 'var(--text-muted)' }}> · {Math.round(pool.pct)}%</span>
                  )}
                </span>
              </div>
              {capSet ? (
                <span
                  className="h-1.5 rounded-full overflow-hidden"
                  style={{ background: 'var(--surface-overlay)' }}
                >
                  <span
                    className="block h-full rounded-full transition-all duration-200"
                    style={{
                      width: `${pool.pct}%`,
                      background: pool.over ? 'var(--status-warning)' : 'var(--status-success)',
                    }}
                  />
                </span>
              ) : (
                <button
                  onClick={() => onOpenSettings?.('statusline')}
                  className={`self-start text-[10px] underline decoration-dotted ${LINK_CLASS}`}
                >
                  Set your included-credit allowance in Settings
                </button>
              )}
              {pool.billed > 0 && (
                <span className="text-[10px]" style={{ color: 'var(--status-warning)' }}>
                  {aiUsageCycle ? 'Additional usage this cycle' : 'Billed beyond included credits'}:{' '}
                  {formatBilledUsd(pool.billed)}
                </span>
              )}
            </div>

            {/* SECONDARY: the whole-month per-model breakdown, collapsed so the
                pool stays the focus. The chip's tooltip mirrors this. */}
            {aiUsage.items.length === 0 ? (
              <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                No AI-credit usage recorded this month.
              </div>
            ) : (
              <details className="group">
                <summary className="cursor-pointer list-none text-[9px] uppercase tracking-wide select-none transition-colors text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
                  This month, by model
                </summary>
                <div className="mt-1 flex flex-col gap-1">
                  <div
                    className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 text-[9px] uppercase tracking-wide"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    <span>Model</span>
                    <span className="text-right">Credits</span>
                    <span className="text-right">Covered</span>
                    <span className="text-right">Billed</span>
                  </div>
                  {aiUsage.items.map((it, i) => (
                    <div
                      key={i}
                      className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      <span
                        className="truncate"
                        style={{ color: 'var(--text-primary)' }}
                        title={`${it.product} ${it.sku} ${it.model}`.trim()}
                      >
                        {it.model || it.sku || it.product || 'usage'}
                      </span>
                      <span className="text-right">{formatCredits(it.grossQuantity)}</span>
                      <span className="text-right" style={{ color: 'var(--text-muted)' }}>
                        {usd(it.coveredAmount)}
                      </span>
                      <span
                        className="text-right"
                        style={{
                          color: it.billedAmount > 0 ? 'var(--status-warning)' : 'var(--text-muted)',
                        }}
                      >
                        {usd(it.billedAmount)}
                      </span>
                    </div>
                  ))}
                  <div
                    className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 border-t mt-0.5 pt-1 font-medium"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
                  >
                    <span>Total</span>
                    <span className="text-right">{formatCredits(totalGrossCredits)}</span>
                    <span className="text-right" style={{ color: 'var(--text-muted)' }}>
                      {usd(aiUsage.totals.coveredAmount)}
                    </span>
                    <span
                      className="text-right"
                      style={
                        aiUsage.totals.billedAmount > 0
                          ? { color: 'var(--status-warning)' }
                          : undefined
                      }
                    >
                      {usd(aiUsage.totals.billedAmount)}
                    </span>
                  </div>
                </div>
              </details>
            )}

            {/* A month overage that predates this cycle (e.g. a prior plan). Shown
                quietly so the stale charge is explained, not alarming. */}
            {pool.priorPlanBilled > 0 && (
              <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                Earlier this month: {formatBilledUsd(pool.priorPlanBilled)} billed on your prior
                plan, before this cycle.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Codex section */}
      <div className={CARD_CLASS} style={CARD_STYLE}>
        <SectionHeader title="Codex" note={codexSession ? undefined : 'no Codex session this run'} />
        <RateWindows session={codexSession} />
      </div>

      {/* Claude section */}
      <div className={CARD_CLASS} style={CARD_STYLE}>
        <SectionHeader title="Claude" note={claudeSession ? undefined : 'no Claude session this run'} />
        <RateWindows session={claudeSession} />
      </div>

      <div className="flex items-center justify-between pt-0.5">
        <button
          onClick={() => onOpenSettings?.('statusline')}
          className={`text-[10px] ${LINK_CLASS}`}
        >
          Copilot meter settings
        </button>
        <DialogButton
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh GitHub usage"
          variant="secondary"
        >
          {REFRESH_GLYPH} {refreshing ? 'Refreshing' : 'Refresh'}
        </DialogButton>
      </div>
    </div>
  )
}
