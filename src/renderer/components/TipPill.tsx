import React, { useEffect, useState } from 'react'
import { useTipsStore } from '../stores/tipsStore'
import { useSettingsStore } from '../stores/settingsStore'

interface Props {
  onClick: () => void
}

/**
 * Animated pill shown to the left of the Restart button in session header.
 * Shows the current tip's shortText. Pulses subtly to draw attention.
 */
export default function TipPill({ onClick }: Props) {
  const currentTipId = useTipsStore((s) => s.currentTipId)
  const silenced = useTipsStore((s) => s.silencedUntilRestart)
  const showTips = useSettingsStore((s) => s.settings.showTips)

  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setMounted(true), 200)
    return () => clearTimeout(t)
  }, [currentTipId])

  if (!showTips || silenced || !currentTipId) return null

  const current = useTipsStore.getState().getCurrentTip()
  if (!current) return null

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs
        bg-surface0/70 hover:bg-surface0
        border border-surface1 hover:border-surface2
        text-subtext0 hover:text-text
        transition-all duration-200 max-w-[340px] truncate
        ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'}`}
      title="Click for details"
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 opacity-70"
        aria-hidden
      >
        <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2z" />
      </svg>
      <span className="truncate">{current.content.shortText}</span>
    </button>
  )
}
