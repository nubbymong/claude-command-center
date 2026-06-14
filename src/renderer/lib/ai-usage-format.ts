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

// U+00B7 MIDDLE DOT. Separates the demoted billed-overage suffix from the credit
// count in the no-cap idiom ("Copilot 500 · +$11.69"). Built via String.fromCodePoint
// (never a \u{...} escape) so it survives esbuild when the label reaches JSX.
const MIDDLE_DOT = String.fromCodePoint(0xb7)

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
 * Idiom (mirrors github.com's AI-usage card in a condensed strip form). The
 * credit COUNT is always the headline; the cap is the warning threshold:
 *   - cap set:   "Copilot 891/20k", warning tone ONLY when used > cap
 *                (the over-allowance signal, e.g. "Copilot 21k/20k")
 *   - no cap, no overage:  "Copilot 8.1k"
 *   - no cap, billed > 0:  "Copilot 8.1k · +$11.69" (billed demoted to a small
 *                trailing annotation; tone stays normal -- without a cap there is
 *                no allowance to exceed, so the chip does not cry wolf)
 *
 * When `cycle` is provided it is PREFERRED over the whole-month report: GitHub's
 * billing card counts AI-credit usage only within the current plan cycle (e.g.
 * since a mid-month Max upgrade), and the cycle figure is reconstructed to match
 * it. The whole-month report (which can be dominated by pre-upgrade usage and a
 * stale prior-plan overage) is the fallback when no cycle start is configured.
 *
 * `cap` is the user-entered included-credit allowance (copilotIncludedCredits),
 * a CREDIT count, or null/undefined when unknown.
 */
export function selectAiChip(
  report: AiUsageReport,
  cap: number | null | undefined,
  cycle?: CycleCredits | null,
): AiChipModel {
  // Prefer the cycle-scoped figure (matches GitHub's billing card) over the
  // whole-month aggregate when a plan cycle is configured.
  const creditsUsed = cycle
    ? cycle.creditsUsed
    : report.items.reduce((sum, it) => sum + it.grossQuantity, 0)
  const billedAmount = cycle ? cycle.billedUsd : report.totals.billedAmount

  const used = formatCredits(creditsUsed)
  const capSet = cap != null && cap > 0

  if (capSet) {
    const capLabel = formatCredits(cap)
    const over = creditsUsed > cap
    return {
      label: `Copilot ${used}/${capLabel}`,
      ariaLabel: over
        ? `Copilot credits used: ${used} of ${capLabel} (over your included allowance)`
        : `Copilot credits used: ${used} of ${capLabel}`,
      tone: over ? 'warning' : 'normal',
      creditsUsed,
      billedAmount,
    }
  }

  if (billedAmount > 0) {
    const usd = formatBilledUsd(billedAmount)
    return {
      label: `Copilot ${used} ${MIDDLE_DOT} ${usd}`,
      ariaLabel: `Copilot credits used: ${used}, billed ${usd}`,
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

export interface UsagePool {
  /** Credits used in the active window (cycle when configured, else whole month). */
  used: number
  /** Overage billed in the active window, USD. */
  billed: number
  /** Percentage of the cap consumed (0 when no cap), clamped to 100. */
  pct: number
  /** True when `used` exceeds the cap (cap set only). */
  over: boolean
  /** True when an included-credit cap is configured. */
  capSet: boolean
  /** A whole-month overage that predates the current cycle: nonzero only when a
   *  cycle is set, that cycle is fully covered (billedUsd 0), yet the month
   *  carries a billed amount — i.e. the charge happened on a prior plan/cycle. */
  priorPlanBilled: number
}

/**
 * Resolves the included-credit progress bar shown in the popover and the
 * Settings live preview. Prefers the cycle figure (matches GitHub's billing
 * card) over the whole-month aggregate, computes the cap percentage, and splits
 * out any overage that predates the cycle so the UI can label it as prior-plan
 * billing instead of alarming the user about a charge they already expected.
 */
export function selectUsagePool(
  report: AiUsageReport,
  cap: number | null | undefined,
  cycle?: CycleCredits | null,
): UsagePool {
  const monthUsed = report.items.reduce((sum, it) => sum + it.grossQuantity, 0)
  const monthBilled = report.totals.billedAmount
  const used = cycle ? cycle.creditsUsed : monthUsed
  const billed = cycle ? cycle.billedUsd : monthBilled
  const capSet = cap != null && cap > 0
  const pct = capSet ? Math.min(100, (used / (cap as number)) * 100) : 0
  const over = capSet && used > (cap as number)
  const priorPlanBilled =
    cycle != null && cycle.billedUsd === 0 && monthBilled > 0 ? monthBilled : 0
  return { used, billed, pct, over, capSet, priorPlanBilled }
}
