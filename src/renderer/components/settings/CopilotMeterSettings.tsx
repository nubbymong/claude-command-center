import React from 'react'
import { useSettingsStore } from '../../stores/settingsStore'
import { useGitHubStore } from '../../stores/githubStore'
import { selectAiChip, selectUsagePool } from '../../lib/ai-usage-format'
import type { AiUsageReport, CycleCredits } from '../../../shared/github-types'

/**
 * Inline Copilot AI-credits config for the Status Line settings tab, shown right
 * under the "Copilot Usage" toggle when the meter is enabled. It owns the three
 * values GitHub does not expose through its API for personal accounts -- the
 * plan label, the included-credit allowance, and the plan-cycle start -- plus a
 * live preview of the status-bar chip. Replaces the old GitHub-tab AiUsageSettings
 * (which was just the cap), keeping a single source for meter configuration.
 */

// U+26A0 WARNING SIGN. Built via String.fromCodePoint (never a \u{...} escape in
// JSX, which esbuild rejects) so the over-allowance preview reads "Copilot ⚠".
const WARN_GLYPH = String.fromCodePoint(0x26a0)

// A representative figure for the preview before the live cycle has loaded (the
// meter was just enabled, or no billing token is configured yet). Shows the chip
// FORMAT honestly without inventing an alarming number.
const SAMPLE_USED = 891

function sampleReport(used: number): AiUsageReport {
  return {
    fetchedAt: 0,
    source: 'ai_credit',
    timePeriod: { year: 0, month: 0 },
    items: [
      {
        product: 'copilot',
        sku: '',
        model: 'sample',
        unitType: 'ai-units',
        grossQuantity: used,
        grossAmount: 0,
        coveredQuantity: used,
        coveredAmount: 0,
        billedQuantity: 0,
        billedAmount: 0,
      },
    ],
    totals: { grossAmount: 0, coveredAmount: 0, billedAmount: 0 },
  }
}

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <label className="flex items-start justify-between gap-3 text-sm">
      <div className="min-w-0">
        <div className="text-text leading-tight">{label}</div>
        <div className="text-[11px] text-overlay0 leading-tight mt-0.5">{hint}</div>
      </div>
      {children}
    </label>
  )
}

export default function CopilotMeterSettings() {
  const enabled = useSettingsStore((s) => s.settings.githubAiUsageEnabled)
  const planName = useSettingsStore((s) => s.settings.copilotPlanName)
  const cap = useSettingsStore((s) => s.settings.copilotIncludedCredits)
  const cycleStart = useSettingsStore((s) => s.settings.copilotCreditsCycleStart)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const aiUsage = useGitHubStore((s) => s.aiUsage)
  const aiUsageCycle = useGitHubStore((s) => s.aiUsageCycle)
  const loadAiUsage = useGitHubStore((s) => s.loadAiUsage)

  // Only shown when the meter is enabled (the per-account aiCredits toggle writes
  // through to githubAiUsageEnabled). Off = the whole section is hidden.
  if (!enabled) return null

  const onPlanChange = (raw: string): void => {
    const trimmed = raw.trim()
    void updateSettings({ copilotPlanName: trimmed === '' ? null : trimmed })
  }

  const onCapChange = (raw: string): void => {
    const trimmed = raw.trim()
    // Empty = "unknown" (null). Otherwise a non-negative number; ignore garbage
    // so a stray keystroke cannot persist NaN.
    if (trimmed === '') {
      void updateSettings({ copilotIncludedCredits: null })
      return
    }
    const n = Number(trimmed)
    if (Number.isFinite(n) && n >= 0) void updateSettings({ copilotIncludedCredits: n })
  }

  const onCycleChange = (raw: string): void => {
    const v = raw.trim() === '' ? null : raw
    // Persist FIRST, then force a recompute so the cycle figure reflects the new
    // start immediately. The force-refresh is chained on the persist so the main
    // process re-reads the new date before fetching, not the stale one.
    void updateSettings({ copilotCreditsCycleStart: v }).then(() =>
      loadAiUsage(true).catch(() => {}),
    )
  }

  // Live preview: prefer real usage data; fall back to a representative sample so
  // the chip FORMAT is visible the moment the meter is enabled. When a cycle
  // start is set we preview the cycle idiom; otherwise the whole-month idiom.
  const previewCycle: CycleCredits | null = cycleStart
    ? aiUsageCycle ?? {
        since: cycleStart,
        through: cycleStart,
        creditsUsed: SAMPLE_USED,
        billedUsd: 0,
      }
    : null
  const previewReport = aiUsage ?? sampleReport(previewCycle?.creditsUsed ?? SAMPLE_USED)
  const chip = selectAiChip(previewReport, cap, previewCycle)
  const pool = selectUsagePool(previewReport, cap, previewCycle)
  const previewLabel = chip.tone === 'warning' ? `${chip.label} ${WARN_GLYPH}` : chip.label
  const isSample = aiUsage == null || (cycleStart != null && aiUsageCycle == null)

  return (
    <div className="rounded-xl bg-surface0/30 border border-surface0/60 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-surface0/40 flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-overlay1 shrink-0">
          <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8 5v3l2 1.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <h3 className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Copilot AI credits</h3>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-[11px] text-overlay0 leading-relaxed">
          GitHub does not expose your Copilot plan, allowance, or cycle start through its API for
          personal accounts. Set them here so the status-bar chip matches your billing page.
        </p>

        <Row label="Plan" hint="Shown next to the meter, e.g. Max, Pro, or Plus.">
          <input
            type="text"
            className="bg-surface0 p-1 rounded w-24 text-right"
            value={planName ?? ''}
            placeholder="Max"
            onChange={(e) => onPlanChange(e.target.value)}
          />
        </Row>

        <Row
          label="Included AI credits"
          hint="Your plan's monthly AI-credit allowance, a credit count (not dollars)."
        >
          <input
            type="number"
            min={0}
            step="1"
            inputMode="numeric"
            className="bg-surface0 p-1 rounded w-24 text-right"
            value={cap ?? ''}
            placeholder="20000"
            onChange={(e) => onCapChange(e.target.value)}
          />
        </Row>

        <Row
          label="Track usage since"
          hint="Usually your latest plan change. Counts credits only from this date, matching GitHub's cycle."
        >
          <input
            type="date"
            className="bg-surface0 p-1 rounded text-right"
            value={cycleStart ?? ''}
            onChange={(e) => onCycleChange(e.target.value)}
          />
        </Row>

        {/* Live preview of the status-bar chip. */}
        <div className="flex items-center gap-2 pt-1 border-t border-surface0/40">
          <span className="text-[11px] text-overlay0">Preview</span>
          <span
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs tabular-nums"
            style={{
              color: chip.tone === 'warning' ? 'var(--status-warning)' : 'var(--text-muted)',
              border: `1px solid ${
                chip.tone === 'warning'
                  ? 'color-mix(in srgb, var(--status-warning) 50%, transparent)'
                  : 'var(--border-subtle)'
              }`,
              background:
                chip.tone === 'warning'
                  ? 'color-mix(in srgb, var(--status-warning) 12%, transparent)'
                  : 'transparent',
            }}
          >
            {previewLabel}
          </span>
          {pool.capSet && (
            <span className="flex items-center gap-1.5">
              <span className="w-20 h-1.5 rounded-full overflow-hidden bg-surface0">
                <span
                  className="block h-full rounded-full transition-all duration-200"
                  style={{
                    width: `${pool.pct}%`,
                    background: pool.over ? 'var(--status-warning)' : 'var(--status-success)',
                  }}
                />
              </span>
              <span className="text-[10px] text-overlay1 tabular-nums">{Math.round(pool.pct)}%</span>
            </span>
          )}
          {isSample && <span className="text-[10px] text-overlay0">sample until usage loads</span>}
        </div>
      </div>
    </div>
  )
}
