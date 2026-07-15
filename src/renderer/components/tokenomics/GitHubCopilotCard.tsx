import React, { useState } from 'react'
import { useGitHubStore } from '../../stores/githubStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { formatCredits } from '../../lib/ai-usage-format'
import { formatResetTime } from '../../utils/terminalFormatting'

// No \u{...} escapes in JSX (esbuild). U+21BB CLOCKWISE OPEN CIRCLE ARROW.
const REFRESH_GLYPH = String.fromCodePoint(0x21bb)

function usd(n: number): string {
  return `$${n.toFixed(2)}`
}

function openGitHubSettings(): void {
  // Deep-links to the GitHub settings tab, where the per-account re-auth row
  // lives -- the action a scope-missing card needs. (Meter display config -- cap,
  // plan, cycle start -- moved to the Status Line tab; re-auth stays here.)
  // Mirrors the app:openSettings handler in App.tsx.
  window.dispatchEvent(new CustomEvent('app:openSettings', { detail: { tab: 'github' } }))
}

/**
 * GitHub Copilot billing card for the Tokenomics page.
 *
 * CRITICAL distinction from the rest of Tokenomics: every other number on this
 * page is a transcript-derived API-EQUIVALENT ESTIMATE. These are ACTUAL
 * billing credits charged by GitHub. The card is deliberately set apart, both
 * visually (its own raised card, GitHub-blue accent) and verbally (the
 * "billing data from GitHub" qualifier under the title), so the two are never
 * read as the same kind of number.
 *
 * Self-contained: a renderer card over the existing githubStore. It does NOT
 * touch the tokenomics worker / DB / summary pipeline. Rendered by
 * TokenomicsPage only when the meter is enabled AND there is something to show
 * (a report, or a scope-missing state worth guiding the user out of).
 */
export function GitHubCopilotCard() {
  const aiUsage = useGitHubStore((s) => s.aiUsage)
  const aiUsageStatus = useGitHubStore((s) => s.aiUsageStatus)
  const loadAiUsage = useGitHubStore((s) => s.loadAiUsage)
  const cap = useSettingsStore((s) => s.settings.copilotIncludedCredits)
  const [refreshing, setRefreshing] = useState(false)

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await loadAiUsage()
    } finally {
      setRefreshing(false)
    }
  }

  const header = (
    <div className="flex items-start justify-between gap-3 mb-3">
      <div className="flex items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style={{ color: 'var(--text-muted)' }}>
          <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
        </svg>
        <div>
          <div className="text-sm font-semibold text-text">GitHub Copilot</div>
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            billing data from GitHub
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {aiUsage && (
          <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            as of {formatResetTime(new Date(aiUsage.fetchedAt).toISOString())}
          </span>
        )}
        <button
          type="button"
          onClick={handleRefresh}
          disabled={refreshing}
          title="Refresh GitHub usage"
          className="px-2 py-1 rounded-md text-[11px] transition-colors duration-200 disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
          style={{ background: 'var(--surface-panel)', border: '1px solid var(--border-subtle)', color: 'var(--text)' }}
        >
          {REFRESH_GLYPH} {refreshing ? 'Refreshing' : 'Refresh'}
        </button>
      </div>
    </div>
  )

  // Scope-missing: no numbers to show, point the user at Settings (which has the
  // per-auth re-auth path). Same guidance, page-appropriate styling.
  if (!aiUsage) {
    return (
      <section
        className="rounded-xl p-4 mb-5"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
        aria-label="GitHub Copilot billing"
      >
        {header}
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          The GitHub token is missing the billing permission, so Copilot credit usage
          can&apos;t be read. Add the <code style={{ color: 'var(--text)' }}>user</code> scope
          (classic token) or Account permissions{' '}
          <span style={{ color: 'var(--text)' }}>Plan: read</span> (fine-grained token) in
          Settings.
        </div>
        <button
          type="button"
          onClick={openGitHubSettings}
          className="mt-2 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors duration-200 focus-ring"
          style={{ background: 'var(--surface-panel)', border: '1px solid var(--border-subtle)', color: 'var(--text)' }}
        >
          Fix in Settings
        </button>
      </section>
    )
  }

  const items = aiUsage.items
  const totalGrossCredits = items.reduce((sum, it) => sum + it.grossQuantity, 0)
  const billed = aiUsage.totals.billedAmount
  const capSet = cap != null && cap > 0
  const capPct = capSet ? Math.min(100, (totalGrossCredits / (cap as number)) * 100) : 0
  const overCap = capSet && totalGrossCredits > (cap as number)

  return (
    <section
      className="rounded-xl p-4 mb-5"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      aria-label="GitHub Copilot billing"
    >
      {header}

      {items.length === 0 ? (
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          No billed AI-credit usage this period.
        </div>
      ) : (
        <div className="flex flex-col gap-1 text-xs tabular-nums">
          {/* Column header */}
          <div
            className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 text-[10px] uppercase tracking-wider pb-1"
            style={{ color: 'var(--text-muted)' }}
          >
            <span>Model</span>
            <span className="text-right">Credits</span>
            <span className="text-right">Covered</span>
            <span className="text-right">Billed</span>
          </div>

          {/* Per-model rows */}
          {items.map((it, i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 py-0.5"
              style={{ color: 'var(--text-muted)' }}
            >
              <span className="truncate text-text" title={`${it.product} ${it.sku} ${it.model}`.trim()}>
                {it.model || it.sku || it.product || 'usage'}
              </span>
              <span className="text-right">{formatCredits(it.grossQuantity)}</span>
              <span className="text-right">{usd(it.coveredAmount)}</span>
              <span
                className="text-right"
                style={{ color: it.billedAmount > 0 ? 'var(--status-warning)' : 'var(--text-muted)' }}
              >
                {usd(it.billedAmount)}
              </span>
            </div>
          ))}

          {/* Totals */}
          <div
            className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 mt-1 pt-1.5 font-medium text-text"
            style={{ borderTop: '1px solid var(--border-subtle)' }}
          >
            <span>Total</span>
            <span className="text-right">{formatCredits(totalGrossCredits)}</span>
            <span className="text-right" style={{ color: 'var(--text-muted)' }}>
              {usd(aiUsage.totals.coveredAmount)}
            </span>
            <span
              className="text-right"
              style={{ color: billed > 0 ? 'var(--status-warning)' : 'var(--text)' }}
            >
              {usd(billed)}
            </span>
          </div>

          {/* Cap bar (only when the user entered an included-credit cap) */}
          {capSet && (
            <div className="mt-3 flex flex-col gap-1">
              <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--text-muted)' }}>
                <span>
                  {formatCredits(totalGrossCredits)} / {formatCredits(cap as number)} included
                  credits
                </span>
                <span>{Math.round(capPct)}%</span>
              </div>
              <span className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--surface-panel)' }}>
                <span
                  className="block h-full rounded-full transition-all duration-200"
                  style={{
                    width: `${capPct}%`,
                    background: overCap ? 'var(--status-warning)' : 'var(--status-success)',
                  }}
                />
              </span>
            </div>
          )}

          {billed > 0 && (
            <div className="mt-2 text-[11px]" style={{ color: 'var(--status-warning)' }}>
              Billed beyond included credits: {usd(billed)} this period.
            </div>
          )}
        </div>
      )}
    </section>
  )
}
