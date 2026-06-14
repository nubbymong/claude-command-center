import React, { useState } from 'react'
import { useGitHubStore } from '../../stores/githubStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { selectAiChip, formatCredits } from '../../lib/ai-usage-format'
import { formatResetTime } from '../../utils/terminalFormatting'
import AiUsagePopover from '../AiUsagePopover'

// U+26A0 WARNING SIGN. No \u{...} escapes in JSX (esbuild). Rendered via
// String.fromCodePoint and interpolated into the label.
const WARN_GLYPH = String.fromCodePoint(0x26a0)

// Per-model + totals tooltip for the AI-usage chip. Plain text (title attr) so
// it works without a portal. When a plan cycle is set, the cycle's included-
// credit total leads (it's the headline number), then the whole-month per-model
// breakdown, then covered/billed totals and the fetch time.
function buildAiTooltip(
  report: import('../../../shared/github-types').AiUsageReport,
  cycle?: import('../../../shared/github-types').CycleCredits | null,
): string {
  const lines: string[] = []
  if (cycle) {
    lines.push(`Included credits used since ${cycle.since}: ${formatCredits(cycle.creditsUsed)}`)
    if (cycle.billedUsd > 0) lines.push(`Additional usage this cycle: $${cycle.billedUsd.toFixed(2)}`)
    lines.push('') // blank separator before the whole-month breakdown
    lines.push('This month, by model:')
  }
  for (const it of report.items) {
    const name = it.model || it.sku || it.product || 'usage'
    lines.push(
      `${name}: ${formatCredits(it.grossQuantity)} credits, covered $${it.coveredAmount.toFixed(2)}, billed $${it.billedAmount.toFixed(2)}`,
    )
  }
  lines.push(`Covered total: $${report.totals.coveredAmount.toFixed(2)}`)
  lines.push(`Billed total: $${report.totals.billedAmount.toFixed(2)}`)
  lines.push(`as of ${formatResetTime(new Date(report.fetchedAt).toISOString())}`)
  return lines.join('\n')
}

// Placeholder-chip tooltip copy, varied by why there is no report yet. Keeps
// the enabled-but-empty chip honest instead of always blaming the token scope.
function placeholderTooltip(status: import('../../../shared/github-types').AiUsageStatus): string {
  switch (status) {
    case 'no-auth':
      return 'Connect a GitHub account first, then this meter reads your billed AI-credit usage. Click for details.'
    case 'error':
      return "Couldn't reach GitHub for your AI-credit usage. It will retry. Click for details."
    case 'scope-missing':
      return 'No usage data yet. The GitHub token needs the user scope (classic) or the Plan: read permission (fine-grained). Click for details.'
    default:
      return 'Loading your AI-credit usage from GitHub. Click for details.'
  }
}

// Shared compact AI-usage chip. Mirrors github.com's AI-usage card idiom
// ("Copilot X / Y" + billed budget) condensed to fit a strip. Rendered in the
// per-session status strip (and reusable elsewhere). Shown only when the meter
// is enabled. Clicking it toggles the unified usage popover.
//
// No-report states render a placeholder so an enabled meter never fails
// silently (review nit on cd96a71):
//   - needs-auth (scope-missing / no-auth) -> actionable warning chip:
//       "Copilot {warn} Fix auth"
//   - loading / error -> muted "Copilot" placeholder
function AiUsageChip({ onOpenSettings }: { onOpenSettings?: (tab?: 'github' | 'statusline') => void }) {
  const enabled = useSettingsStore((s) => s.settings.githubAiUsageEnabled)
  const aiUsage = useGitHubStore((s) => s.aiUsage)
  const aiUsageStatus = useGitHubStore((s) => s.aiUsageStatus)
  const aiUsageCycle = useGitHubStore((s) => s.aiUsageCycle)
  const cap = useSettingsStore((s) => s.settings.copilotIncludedCredits)
  const [popoverOpen, setPopoverOpen] = useState(false)

  // Feature off = invisible.
  if (!enabled) return null

  // Prefer the cycle-scoped figure (matches GitHub's billing card) when present;
  // selectAiChip falls back to the whole-month report when no cycle is set.
  const chip = aiUsage ? selectAiChip(aiUsage, cap, aiUsageCycle) : null
  // No report + a token/auth problem -> the placeholder is actionable, so it
  // adopts the warning treatment and reads "Fix auth". Loading/error stay muted.
  const needsAuth = !chip && (aiUsageStatus === 'scope-missing' || aiUsageStatus === 'no-auth')
  const warning = chip ? chip.tone === 'warning' : needsAuth
  const color = warning ? 'var(--status-warning)' : 'var(--text-muted)'

  let label: React.ReactNode
  let ariaLabel: string
  if (chip) {
    // The warning glyph is appended here (not baked into the format string) so
    // the data layer stays ASCII-clean and the glyph only ever renders through
    // String.fromCodePoint -- the over-allowance signal reads "Copilot 21k/20k ⚠".
    label = chip.tone === 'warning' ? `${chip.label} ${WARN_GLYPH}` : chip.label
    ariaLabel = chip.ariaLabel
  } else if (needsAuth) {
    label = `Copilot ${WARN_GLYPH} Fix auth`
    ariaLabel = 'Copilot usage: re-authentication needed'
  } else {
    label = 'Copilot'
    ariaLabel = 'Copilot usage: no data yet'
  }

  return (
    <span className="relative flex items-center shrink-0">
      <button
        type="button"
        data-ai-usage-chip
        aria-label={ariaLabel}
        title={chip ? buildAiTooltip(aiUsage!, aiUsageCycle) : placeholderTooltip(aiUsageStatus)}
        onClick={() => setPopoverOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 tabular-nums transition-colors duration-150 focus-ring"
        style={{
          color,
          opacity: chip ? 1 : warning ? 1 : 0.6,
          border: `1px solid ${warning ? 'color-mix(in srgb, var(--status-warning) 50%, transparent)' : 'var(--border-subtle)'}`,
          background: warning ? 'color-mix(in srgb, var(--status-warning) 12%, transparent)' : 'transparent',
        }}
      >
        {label}
      </button>
      <AiUsagePopover
        open={popoverOpen}
        onClose={() => setPopoverOpen(false)}
        onOpenSettings={onOpenSettings}
      />
    </span>
  )
}

export default AiUsageChip
