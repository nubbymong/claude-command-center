import React, { useEffect, useRef, useState } from 'react'
import { useGitHubStore } from '../stores/githubStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore, type Session } from '../stores/sessionStore'
import { formatCredits, formatBilledUsd, selectUsagePool } from '../lib/ai-usage-format'
import { formatResetTime } from '../utils/terminalFormatting'

// No \u{...} escapes in JSX (esbuild). U+21BB CLOCKWISE OPEN CIRCLE ARROW.
const REFRESH_GLYPH = String.fromCodePoint(0x21bb)

function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

// A 5h / 7d rate-limit window pair, read from a session's statusline telemetry.
// Shared by the Codex and Claude provider sections so both render identically.
function RateWindows({ session }: { session: Session | null }) {
  if (!session || session.rateLimitCurrent == null) {
    return <div className="text-[11px] text-overlay1">no session telemetry this run</div>
  }
  return (
    <div className="flex flex-col gap-1 text-[11px] text-subtext0 tabular-nums">
      <div className="flex items-center justify-between gap-2">
        <span>
          5h window <span className="text-text">{Math.round(session.rateLimitCurrent)}%</span>
        </span>
        {session.rateLimitCurrentResets && (
          <span className="text-overlay1">resets {formatResetTime(session.rateLimitCurrentResets)}</span>
        )}
      </div>
      {session.rateLimitWeekly != null && (
        <div className="flex items-center justify-between gap-2">
          <span>
            7d window <span className="text-text">{Math.round(session.rateLimitWeekly)}%</span>
          </span>
          {session.rateLimitWeeklyResets && (
            <span className="text-overlay1">resets {formatResetTime(session.rateLimitWeeklyResets)}</span>
          )}
        </div>
      )}
    </div>
  )
}

function SectionHeader({ title, note }: { title: string; note?: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5">
      <span className="text-[12px] font-semibold text-text">{title}</span>
      {note && <span className="text-[10px] text-overlay1">{note}</span>}
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
      className={`absolute right-0 top-full mt-1.5 z-50 w-80 rounded-lg border border-surface0 bg-mantle shadow-xl p-3 flex flex-col gap-3 transition-all duration-200 ease-out ${
        entered ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1'
      }`}
    >
      {/* GitHub section */}
      <div className="rounded border border-surface0 bg-crust/50 p-2.5">
        <SectionHeader title="GitHub Copilot" note={headerNote} />
        {!aiUsage ? (
          <div className="text-[11px] text-overlay1">
            {aiUsageStatus === 'no-auth' ? (
              <>
                Connect a GitHub account in Settings, then this meter reads your billed
                AI-credit usage.
              </>
            ) : aiUsageStatus === 'scope-missing' ? (
              <>
                The GitHub token is missing the billing permission. Add the{' '}
                <code className="text-overlay0">user</code> scope (classic) or Account
                permissions <span className="text-overlay0">Plan: read</span> (fine-grained)
                in Settings.
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
              className="mt-1.5 block self-start text-[10px] text-overlay1 underline decoration-dotted hover:text-text transition-colors focus-ring"
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
                <span className="text-subtext0">
                  {aiUsageCycle ? 'Included AI credits' : 'Credits this month'}
                  {aiUsageCycle && (
                    <span className="text-overlay1"> since {aiUsageCycle.since}</span>
                  )}
                </span>
                <span className={pool.over ? 'text-red font-medium' : 'text-text'}>
                  {formatCredits(pool.used)}
                  {capSet && ` / ${formatCredits(cap as number)}`}
                  {capSet && <span className="text-overlay1"> · {Math.round(pool.pct)}%</span>}
                </span>
              </div>
              {capSet ? (
                <span className="h-1.5 rounded-full overflow-hidden bg-surface0">
                  <span
                    className={`block h-full rounded-full transition-all duration-200 ${pool.over ? 'bg-red' : 'bg-green'}`}
                    style={{ width: `${pool.pct}%` }}
                  />
                </span>
              ) : (
                <button
                  onClick={() => onOpenSettings?.('statusline')}
                  className="self-start text-[10px] text-overlay1 underline decoration-dotted hover:text-text transition-colors focus-ring"
                >
                  Set your included-credit allowance in Settings
                </button>
              )}
              {pool.billed > 0 && (
                <span className="text-[10px] text-yellow">
                  {aiUsageCycle ? 'Additional usage this cycle' : 'Billed beyond included credits'}:{' '}
                  {formatBilledUsd(pool.billed)}
                </span>
              )}
            </div>

            {/* SECONDARY: the whole-month per-model breakdown, collapsed so the
                pool stays the focus. The chip's tooltip mirrors this. */}
            {aiUsage.items.length === 0 ? (
              <div className="text-[10px] text-overlay1">No AI-credit usage recorded this month.</div>
            ) : (
              <details className="group">
                <summary className="cursor-pointer list-none text-[9px] uppercase tracking-wide text-overlay1 hover:text-subtext0 transition-colors select-none">
                  This month, by model
                </summary>
                <div className="mt-1 flex flex-col gap-1">
                  <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 text-[9px] uppercase tracking-wide text-overlay1">
                    <span>Model</span>
                    <span className="text-right">Credits</span>
                    <span className="text-right">Covered</span>
                    <span className="text-right">Billed</span>
                  </div>
                  {aiUsage.items.map((it, i) => (
                    <div key={i} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 text-subtext0">
                      <span className="truncate text-text" title={`${it.product} ${it.sku} ${it.model}`.trim()}>
                        {it.model || it.sku || it.product || 'usage'}
                      </span>
                      <span className="text-right">{formatCredits(it.grossQuantity)}</span>
                      <span className="text-right text-overlay1">{usd(it.coveredAmount)}</span>
                      <span className={`text-right ${it.billedAmount > 0 ? 'text-yellow' : 'text-overlay1'}`}>
                        {usd(it.billedAmount)}
                      </span>
                    </div>
                  ))}
                  <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-2 border-t border-surface0/70 mt-0.5 pt-1 text-text font-medium">
                    <span>Total</span>
                    <span className="text-right">{formatCredits(totalGrossCredits)}</span>
                    <span className="text-right text-overlay1">{usd(aiUsage.totals.coveredAmount)}</span>
                    <span className={`text-right ${aiUsage.totals.billedAmount > 0 ? 'text-yellow' : ''}`}>
                      {usd(aiUsage.totals.billedAmount)}
                    </span>
                  </div>
                </div>
              </details>
            )}

            {/* A month overage that predates this cycle (e.g. a prior plan). Shown
                quietly so the stale charge is explained, not alarming. */}
            {pool.priorPlanBilled > 0 && (
              <div className="text-[10px] text-overlay1">
                Earlier this month: {formatBilledUsd(pool.priorPlanBilled)} billed on your prior
                plan, before this cycle.
              </div>
            )}
          </div>
        )}
      </div>

      {/* Codex section */}
      <div className="rounded border border-surface0 bg-crust/50 p-2.5">
        <SectionHeader title="Codex" note={codexSession ? undefined : 'no Codex session this run'} />
        <RateWindows session={codexSession} />
      </div>

      {/* Claude section */}
      <div className="rounded border border-surface0 bg-crust/50 p-2.5">
        <SectionHeader title="Claude" note={claudeSession ? undefined : 'no Claude session this run'} />
        <RateWindows session={claudeSession} />
      </div>

      <div className="flex items-center justify-between pt-0.5">
        <button
          onClick={() => onOpenSettings?.('statusline')}
          className="text-[10px] text-overlay1 hover:text-text transition-colors focus-ring"
        >
          Copilot meter settings
        </button>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh GitHub usage"
          className="px-2 py-1 rounded border border-surface0 bg-surface0/40 text-[11px] text-text transition-colors hover:bg-surface0/70 disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
        >
          {REFRESH_GLYPH} {refreshing ? 'Refreshing' : 'Refresh'}
        </button>
      </div>
    </div>
  )
}
