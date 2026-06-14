// Pure formatting helpers for the unified AI-usage meter (repo-strip chip +
// provider popover). Kept framework-free so the chip's number formatting and
// state selection are table-testable without rendering React.
import type { AiUsageReport, CycleCredits } from '../../shared/github-types'

/**
 * Compact credit-count formatter. GitHub's AI-credit grossQuantity is a
 * fractional unit count; we render it for a strip chip where space is tight:
 *   930      -> "930"
 *   8120     -> "8.1k"
 *   20000    -> "20k"
 *   1_250_000-> "1.3m"
 * One decimal place only when it adds signal (8.1k, not 8.0k -> "8k").
 */
export function formatCredits(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) {
    // Sub-1k: whole credits read cleanest. Round to nearest integer.
    return String(Math.round(n))
  }
  if (n < 1_000_000) {
    const k = n / 1000
    // Drop the decimal at exact/large thousands (20k, 100k); keep it where it
    // carries signal (8.1k). >= 100k never needs a decimal in a strip chip.
    if (k >= 100) return `${Math.round(k)}k`
    const rounded = Math.round(k * 10) / 10
    return Number.isInteger(rounded) ? `${rounded}k` : `${rounded.toFixed(1)}k`
  }
  const m = n / 1_000_000
  const rounded = Math.round(m * 10) / 10
  return Number.isInteger(rounded) ? `${rounded}m` : `${rounded.toFixed(1)}m`
}

/** Compact USD formatter for the billed-overage chip: "+$11.69", "+$0.40". */
export function formatBilledUsd(n: number): string {
  const v = Math.max(0, n)
  return `+$${v.toFixed(2)}`
}

export type AiChipTone = 'normal' | 'warning'

export interface AiChipModel {
  /** Short label, e.g. "Copilot 8.1k/20k" or "Copilot +$11.69" or "Copilot 8.1k". */
  label: string
  /** Full a11y/title-less aria label, same text expanded for screen readers. */
  ariaLabel: string
  /** 'warning' once GitHub is billing past the included allowance. */
  tone: AiChipTone
  /** Credits used this period (sum of grossQuantity across items). */
  creditsUsed: number
  /** The billed overage in USD (totals.billedAmount). */
  billedAmount: number
}

/**
 * Selects the repo-strip chip's content + tone from a usage report.
 *
 * Idiom (mirrors github.com's AI-usage card in a condensed strip form):
 *   - no overage (billedAmount <= 0): show credits used, with the cap when set
 *       cap set:   "Copilot 8.1k/20k"
 *       no cap:    "Copilot 8.1k"
 *   - overage (billedAmount > 0): the headline warning signal. Show the billed
 *     amount instead of the credit count (that is the number the user pays):
 *       "Copilot +$11.69"   tone: warning
 *
 * `cap` is the user-entered included-credit denominator (copilotIncludedCredits),
 * or null/undefined when unknown.
 */
export function selectAiChip(
  report: AiUsageReport,
  cap: number | null | undefined,
): AiChipModel {
  const creditsUsed = report.items.reduce((sum, it) => sum + it.grossQuantity, 0)
  const billedAmount = report.totals.billedAmount

  if (billedAmount > 0) {
    const usd = formatBilledUsd(billedAmount)
    return {
      label: `Copilot ${usd}`,
      ariaLabel: `Copilot usage billed over plan: ${usd}`,
      tone: 'warning',
      creditsUsed,
      billedAmount,
    }
  }

  const used = formatCredits(creditsUsed)
  if (cap != null && cap > 0) {
    const capLabel = formatCredits(cap)
    return {
      label: `Copilot ${used}/${capLabel}`,
      ariaLabel: `Copilot credits used: ${used} of ${capLabel}`,
      tone: 'normal',
      creditsUsed,
      billedAmount,
    }
  }
  return {
    label: `Copilot ${used}`,
    ariaLabel: `Copilot credits used: ${used}`,
    tone: 'normal',
    creditsUsed,
    billedAmount,
  }
}
