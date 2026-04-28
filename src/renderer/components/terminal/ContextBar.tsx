import React from 'react'
import { formatTokens, formatDuration, formatResetTime } from '../../utils/terminalFormatting'
import RateLimitBar from './RateLimitBar'
import { useSettingsStore, DEFAULT_STATUS_LINE } from '../../stores/settingsStore'

interface ContextBarProps {
  modelName?: string
  inputTokens?: number
  contextWindowSize?: number
  contextPercent: number
  costUsd?: number
  linesAdded?: number
  linesRemoved?: number
  totalDurationMs?: number
  rateLimitCurrent?: number
  rateLimitCurrentResets?: string
  rateLimitWeekly?: number
  rateLimitWeeklyResets?: string
  rateLimitExtra?: { enabled: boolean; utilization: number; usedUsd: number; limitUsd: number }
  isPeak?: boolean
}

export default function ContextBar({
  modelName, inputTokens, contextWindowSize, contextPercent,
  costUsd, linesAdded, linesRemoved, totalDurationMs,
  rateLimitCurrent, rateLimitCurrentResets,
  rateLimitWeekly, rateLimitWeeklyResets, rateLimitExtra, isPeak
}: ContextBarProps) {
  const sl = useSettingsStore((s) => s.settings.statusLine) || DEFAULT_STATUS_LINE

  // Sophistication pass: most numeric values were rendered in saturated
  // colours (blue model, peach tokens, yellow cost, green/red lines) which
  // made the status row read like a christmas tree. Default everything to
  // subtext0 (neutral) and reserve colour for STATE thresholds that the
  // user actually needs in peripheral vision: context bar fill at warning
  // / danger, peak/off-peak label, rate-limit extra at >80%. Numbers use
  // tabular-nums so they stop dancing as values change.
  const ctxThreshold = contextPercent > 80 ? 'danger' : contextPercent > 50 ? 'warn' : 'ok'
  const ctxColor = ctxThreshold === 'danger' ? 'var(--color-red)'
    : ctxThreshold === 'warn' ? 'var(--color-yellow)'
    : 'var(--color-green)'
  return (
    <div
      className={`flex flex-col shrink-0 bg-crust border-t border-surface0 text-subtext0 ${sl.font === 'mono' ? 'font-mono' : ''}`}
      style={{ fontSize: `${sl.fontSize}px` }}
    >
      {/* Row 1: Context + model + cost + lines */}
      <div className="flex items-center gap-3 px-2 py-1">
        {sl.showModel && modelName && (
          <span className="text-text font-medium">{modelName}</span>
        )}
        {sl.showTokens && inputTokens != null && contextWindowSize ? (
          <span className="tabular-nums">{formatTokens(inputTokens)} / {formatTokens(contextWindowSize)}</span>
        ) : null}
        {sl.showContextBar && (
          <div className="flex items-center gap-1.5">
            <div className="w-20 h-1.5 bg-surface1 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${contextPercent}%`,
                  backgroundColor: ctxColor,
                }}
              />
            </div>
            <span className="tabular-nums">{Math.round(contextPercent)}%</span>
          </div>
        )}
        <div className="flex-1" />
        {sl.showCost && costUsd != null && (
          <span className="tabular-nums" title="API equivalent cost (not billed on Max plan)">API eq ${costUsd.toFixed(4)}</span>
        )}
        {sl.showLinesChanged && linesAdded != null && (
          <span
            className="tabular-nums"
            style={{ color: 'color-mix(in srgb, var(--color-green) 65%, var(--color-subtext0))' }}
          >
            +{linesAdded}
          </span>
        )}
        {sl.showLinesChanged && linesRemoved != null && linesRemoved > 0 && (
          <span
            className="tabular-nums"
            style={{ color: 'color-mix(in srgb, var(--color-red) 65%, var(--color-subtext0))' }}
          >
            −{linesRemoved}
          </span>
        )}
        {sl.showDuration && totalDurationMs != null && (
          <span className="text-overlay1 tabular-nums">{formatDuration(totalDurationMs)}</span>
        )}
      </div>
      {/* Row 2: Rate limits (only shown when data available) */}
      {sl.showRateLimits && rateLimitCurrent != null && (
        <div className="flex items-center gap-3 px-2 py-0.5 border-t border-surface0/60">
          <RateLimitBar label="5h" pct={rateLimitCurrent} resets={rateLimitCurrentResets} />
          {rateLimitWeekly != null && (
            <RateLimitBar label="7d" pct={rateLimitWeekly} resets={rateLimitWeeklyResets} />
          )}
          {rateLimitExtra?.enabled && (
            <span className="text-overlay1 tabular-nums">
              extra: <span className={rateLimitExtra.utilization > 80 ? 'text-red' : ''}>${rateLimitExtra.usedUsd.toFixed(2)}</span>
              /${rateLimitExtra.limitUsd.toFixed(0)}
            </span>
          )}
          {isPeak != null && (
            <span
              className="px-1.5 py-px rounded text-[10px] font-medium tracking-wide uppercase border"
              style={{
                color: isPeak ? 'var(--color-red)' : 'var(--color-overlay2)',
                borderColor: isPeak ? 'color-mix(in srgb, var(--color-red) 35%, transparent)' : 'var(--color-surface1)',
                backgroundColor: isPeak ? 'color-mix(in srgb, var(--color-red) 10%, transparent)' : 'transparent',
              }}
              title={isPeak ? 'Peak hours: 5-11 AM PT weekdays — 5h limit consumed faster' : 'Off-peak: normal rate limit consumption'}
            >
              {isPeak ? 'Peak' : 'Off-peak'}
            </span>
          )}
          <div className="flex-1" />
          {sl.showResetTime && rateLimitCurrentResets && (
            <span className="text-overlay1 tabular-nums" title="5h window resets">resets {formatResetTime(rateLimitCurrentResets)}</span>
          )}
        </div>
      )}
    </div>
  )
}
