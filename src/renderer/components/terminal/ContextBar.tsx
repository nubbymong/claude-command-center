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

  return (
    <div className="flex flex-col shrink-0 bg-crust border-t border-surface0 text-xs font-mono">
      {/* Row 1: Context + model + cost + lines */}
      <div className="flex items-center gap-3 px-2 py-1">
        {sl.showModel && modelName && (
          <span className="text-blue font-medium">{modelName}</span>
        )}
        <div className="flex items-center gap-1.5">
          {sl.showTokens && inputTokens != null && contextWindowSize ? (
            <span className="text-peach">{formatTokens(inputTokens)} / {formatTokens(contextWindowSize)}</span>
          ) : null}
        </div>
        {sl.showContextBar && (
          <div className="flex items-center gap-1.5">
            <div className="w-20 h-1.5 bg-surface1 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${contextPercent}%`,
                  backgroundColor: contextPercent > 80 ? '#F38BA8'
                    : contextPercent > 50 ? '#F9E2AF'
                    : '#A6E3A1'
                }}
              />
            </div>
            <span className="text-subtext0">{Math.round(contextPercent)}%</span>
          </div>
        )}
        <div className="flex-1" />
        {sl.showCost && costUsd != null && (
          <span className="text-yellow" title="API equivalent cost (not billed on Max plan)">API eq ${costUsd.toFixed(4)}</span>
        )}
        {sl.showLinesChanged && linesAdded != null && (
          <span className="text-green">+{linesAdded}</span>
        )}
        {sl.showLinesChanged && linesRemoved != null && linesRemoved > 0 && (
          <span className="text-red">-{linesRemoved}</span>
        )}
        {sl.showDuration && totalDurationMs != null && (
          <span className="text-overlay0">{formatDuration(totalDurationMs)}</span>
        )}
      </div>
      {/* Row 2: Rate limits (only shown when data available) */}
      {sl.showRateLimits && rateLimitCurrent != null && (
        <div className="flex items-center gap-3 px-2 py-0.5 border-t border-surface0/50">
          <RateLimitBar label="5h" pct={rateLimitCurrent} resets={rateLimitCurrentResets} />
          {rateLimitWeekly != null && (
            <RateLimitBar label="7d" pct={rateLimitWeekly} resets={rateLimitWeeklyResets} />
          )}
          {rateLimitExtra?.enabled && (
            <span className="text-overlay0">
              extra: <span className={rateLimitExtra.utilization > 80 ? 'text-red' : 'text-teal'}>${rateLimitExtra.usedUsd.toFixed(2)}</span>
              <span className="text-overlay0">/${rateLimitExtra.limitUsd.toFixed(0)}</span>
            </span>
          )}
          {isPeak != null && (
            <span className={`font-medium ${isPeak ? 'text-red' : 'text-green'}`} title={isPeak ? 'Peak hours: 5-11 AM PT weekdays — 5h limit consumed faster' : 'Off-peak: normal rate limit consumption'}>
              {isPeak ? 'PEAK' : 'OFF-PEAK'}
            </span>
          )}
          <div className="flex-1" />
          {sl.showResetTime && rateLimitCurrentResets && (
            <span className="text-overlay0" title="5h window resets">resets {formatResetTime(rateLimitCurrentResets)}</span>
          )}
        </div>
      )}
    </div>
  )
}
