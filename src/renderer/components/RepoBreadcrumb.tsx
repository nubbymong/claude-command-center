import React, { useState } from 'react'
import { Session } from '../stores/sessionStore'
import { useGitHubStore } from '../stores/githubStore'
import { useSettingsStore } from '../stores/settingsStore'
import { selectAiChip, formatCredits } from '../lib/ai-usage-format'
import { formatResetTime } from '../utils/terminalFormatting'
import AiUsagePopover from './AiUsagePopover'

// Per-model + totals tooltip for the AI-usage chip. Plain text (title attr) so
// it works without a portal: one line per model, then covered/billed totals and
// the fetch time.
function buildAiTooltip(
  report: import('../../shared/github-types').AiUsageReport,
): string {
  const lines: string[] = []
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

// Compact AI-usage chip for the repo strip. Mirrors github.com's AI-usage card
// idiom ("X / Y AI credits" + billed budget) condensed to fit the strip. Shown
// only when the meter is enabled and a report has arrived. Clicking it toggles
// the unified usage popover.
// Placeholder-chip tooltip copy, varied by why there is no report yet. Keeps
// the enabled-but-empty chip honest instead of always blaming the token scope.
function placeholderTooltip(status: import('../../shared/github-types').AiUsageStatus): string {
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

function AiUsageChip({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const enabled = useSettingsStore((s) => s.settings.githubAiUsageEnabled)
  const aiUsage = useGitHubStore((s) => s.aiUsage)
  const aiUsageStatus = useGitHubStore((s) => s.aiUsageStatus)
  const cap = useSettingsStore((s) => s.settings.copilotIncludedCredits)
  const [popoverOpen, setPopoverOpen] = useState(false)

  // Feature off = invisible. Enabled with NO data yet (scope missing, no auth,
  // first fetch pending) renders a muted placeholder chip instead of vanishing
  // — otherwise the popover's "no data + scope hint" state is unreachable and
  // an enabled meter fails silently (review nit on cd96a71).
  if (!enabled) return null

  const chip = aiUsage ? selectAiChip(aiUsage, cap) : null
  const warning = chip?.tone === 'warning'
  const color = warning ? 'var(--status-warning)' : 'var(--text-muted)'

  return (
    <span className="relative flex items-center shrink-0">
      <button
        type="button"
        data-ai-usage-chip
        aria-label={chip?.ariaLabel ?? 'AI usage: no data yet'}
        title={chip ? buildAiTooltip(aiUsage!) : placeholderTooltip(aiUsageStatus)}
        onClick={() => setPopoverOpen((v) => !v)}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 tabular-nums transition-colors duration-150 focus-ring"
        style={{
          color,
          opacity: chip ? 1 : 0.6,
          border: `1px solid ${warning ? 'color-mix(in srgb, var(--status-warning) 50%, transparent)' : 'var(--border-subtle)'}`,
          background: warning ? 'color-mix(in srgb, var(--status-warning) 12%, transparent)' : 'transparent',
        }}
      >
        {chip?.label ?? 'AI'}
      </button>
      <AiUsagePopover
        open={popoverOpen}
        onClose={() => setPopoverOpen(false)}
        onOpenSettings={onOpenSettings}
      />
    </span>
  )
}

// Passive orientation strip (spec section 8): working dir on the left, repo slug
// + connection state on the right. NOT a toolbar -- no actions. Does not repeat
// the active session name (the tab already shows it). The path collapses first
// on narrow widths (min-w-0 truncate); the repo side is shrink-0.
//
// v1.5.9: the v1.5.7 account-email chip was removed. Account labels are now
// user-managed aliases set per session from the sidebar right-click menu.
// v2: a compact AI-usage chip sits beside the connection state when the GitHub
// AI-credits meter is enabled (githubAiUsageEnabled) and a report has arrived.
export default function RepoBreadcrumb({
  session,
  onOpenSettings,
}: {
  session: Session
  onOpenSettings?: () => void
}) {
  const cwd = session.workingDirectory || ''
  const gi = session.githubIntegration
  const slug = gi?.repoSlug
  const connected = !!gi?.enabled && !!slug
  if (!cwd && !slug) return null
  return (
    <div className="flex items-center gap-2 px-4 py-1 text-[11px] border-b shrink-0"
      style={{ background: 'var(--surface-panel)', borderColor: 'var(--border-subtle)', color: 'var(--text-muted)' }}>
      <span className="font-mono truncate min-w-0" title={cwd}>{cwd}</span>
      <span className="flex-1" />
      <AiUsageChip onOpenSettings={onOpenSettings} />
      {slug && (
        <span className="flex items-center gap-1.5 shrink-0">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 22 12c0-5.52-4.48-10-10-10z"/></svg>
          <span className="truncate max-w-[180px]" title={gi?.repoUrl || slug}>{slug}</span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: connected ? 'var(--status-success)' : 'var(--text-muted)' }} aria-hidden />
            <span style={{ color: connected ? 'var(--status-success)' : 'var(--text-muted)' }}>{connected ? 'connected' : 'detected'}</span>
          </span>
        </span>
      )}
    </div>
  )
}
