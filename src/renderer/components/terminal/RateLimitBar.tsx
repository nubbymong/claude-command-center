import React from 'react'
import { formatResetTime } from '../../utils/terminalFormatting'

// Slim contiguous bar instead of a row of dots. Easier to scan in
// peripheral vision and uses less horizontal space — UX audit 2026-04-25
// flagged the dot row as the hardest-to-parse element on the status line.
/**
 * Short code for a bucket label, for the compact (multi-account footer) form.
 *
 * The footer shows one row per account, each with every bucket, so the words
 * repeat across the whole strip and crowd out the thing you actually read — the
 * coloured bar. Labels come from the API and are open-ended (5h, Weekly, then a
 * bucket per model), so this is a rule rather than a fixed list.
 *
 * Only the fixed TIME windows shorten. "5h" is already minimal and Weekly goes
 * to a single "W" — both are positional and unambiguous once seen. Model
 * buckets keep their full name: "Fable" is the label actually worth scanning
 * for, and truncating it ("Fab") saves a few pixels at the cost of the one
 * label that has to stay legible as new models are added.
 */
export function shortBucketLabel(label: string): string {
  const l = label.trim()
  if (/^\d+\s*h$/i.test(l)) return l.replace(/\s+/g, '').toLowerCase()  // "5h", "5 H" -> 5h
  if (/^week(ly)?$/i.test(l)) return 'W'
  return l
}

/**
 * Placeholder meter for a statusline that has not reported yet.
 *
 * Geometry is IDENTICAL to the live bar (same label form, same track width and
 * height, same gaps), so the strip does not reflow when the first payload
 * arrives -- the fill simply appears. That matters more than it sounds: the
 * footer centres its cluster, so a width change on first tick would visibly
 * shove every other account sideways.
 *
 * No colour and no number: the live bar's colour ramp and percentage both carry
 * meaning, and a placeholder that borrowed either would read as a real value.
 */
export function RateLimitBarPending({ label, compact }: { label: string; compact?: boolean }) {
  return (
    <span
      className="flex items-center gap-1.5"
      title={`${label} window — waiting for the status line`}
      data-testid="rate-limit-pending"
    >
      <span className="text-subtext0 opacity-60">{compact ? shortBucketLabel(label) : `${label}:`}</span>
      <span
        className="statusline-pending-track inline-block bg-surface1 rounded-sm"
        style={{ width: compact ? '46px' : '64px', height: '6px' }}
        role="progressbar"
        // Indeterminate: aria-valuenow is deliberately ABSENT (there is no
        // value yet), but min/max stay so the bar matches the live one and
        // validators that expect a bounded range are satisfied.
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext="waiting for the status line"
        aria-label={`${label} rate limit utilisation, not yet reported`}
      />
      {!compact && <span className="text-subtext0 tabular-nums opacity-60">--%</span>}
    </span>
  )
}

export default function RateLimitBar({ label, pct, resets, showReset, compact }: { label: string; pct: number; resets?: string; showReset?: boolean; compact?: boolean }) {
  const clamped = Math.min(100, Math.max(0, pct))
  // Drive from theme tokens so the bar adapts to light/dark — hard-
  // coded Catppuccin Mocha hex didn't repaint when the user flipped
  // theme and clashed with the lighter palette.
  // Monotonic warm ramp: green -> yellow -> peach -> red as utilisation rises
  // (peach is the hotter of the two middle stops).
  const color = clamped >= 90
    ? 'var(--color-red)'
    : clamped >= 70
      ? 'var(--color-peach)'
      : clamped >= 50
        ? 'var(--color-yellow)'
        : 'var(--color-green)'
  // Compact drops the colon and the trailing "NN%" and shortens the label; the
  // exact figure moves into the tooltip, which is where it was always going to
  // be read from anyway once there are four accounts of these on one strip.
  const pctText = `${Math.round(clamped)}%`
  const title = [
    `${label} window`,
    compact ? `${pctText} used` : '',
    resets ? `resets ${formatResetTime(resets)}` : '',
  ].filter(Boolean).join(' — ')
  return (
    <span
      className="flex items-center gap-1.5"
      title={title}
    >
      <span className="text-subtext0">{compact ? shortBucketLabel(label) : `${label}:`}</span>
      <span
        className="inline-block bg-surface1 rounded-sm overflow-hidden"
        style={{ width: compact ? '46px' : '64px', height: '6px' }}
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} rate limit utilisation`}
      >
        <span
          className="block h-full rounded-sm transition-[width] duration-300 ease-out"
          style={{ width: `${clamped}%`, backgroundColor: color }}
        />
      </span>
      {!compact && <span className="text-subtext0 tabular-nums">{pctText}</span>}
      {showReset && resets && (
        <span className="tabular-nums" style={{ color: 'var(--text-muted)' }}>resets {formatResetTime(resets)}</span>
      )}
    </span>
  )
}
