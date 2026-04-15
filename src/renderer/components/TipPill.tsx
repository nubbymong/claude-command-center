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
      className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs
        bg-gradient-to-r from-mauve/20 to-blue/10
        border border-mauve/40
        text-subtext1 hover:text-text hover:border-mauve
        transition-all max-w-[340px] truncate
        ${mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'}
        hover:scale-[1.02]`}
      style={{
        animation: mounted ? 'tip-pulse 4s ease-in-out infinite' : undefined,
      }}
      title="Click for details"
    >
      <span className="text-mauve shrink-0" aria-hidden>💡</span>
      <span className="truncate">{current.content.shortText}</span>
    </button>
  )
}

// Inject keyframes once
const TIP_STYLE_ID = 'tip-pulse-keyframes'
if (typeof document !== 'undefined' && !document.getElementById(TIP_STYLE_ID)) {
  const style = document.createElement('style')
  style.id = TIP_STYLE_ID
  style.textContent = `
    @keyframes tip-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(203, 166, 247, 0); }
      50% { box-shadow: 0 0 12px 2px rgba(203, 166, 247, 0.25); }
    }
  `
  document.head.appendChild(style)
}
