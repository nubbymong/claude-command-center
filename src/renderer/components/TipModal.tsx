import React from 'react'
import { useTipsStore } from '../stores/tipsStore'
import type { ViewType } from '../types/views'
import { resolveBody, resolveFocusHint } from '../tips-library'

interface Props {
  onClose: () => void
  onNavigate?: (view: ViewType) => void
}

/** Render a tip body with **bold** markdown segments and line breaks */
function renderBody(body: string): React.ReactNode {
  return body.split('\n').map((line, i) => {
    if (line.trim() === '') return <div key={i} className="h-2" />
    const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    return (
      <p key={i} className="text-sm text-subtext0 leading-relaxed mb-2">
        {parts.map((part, j) => {
          if (part.startsWith('**') && part.endsWith('**')) {
            return <strong key={j} className="text-text font-semibold">{part.slice(2, -2)}</strong>
          }
          if (part.startsWith('`') && part.endsWith('`')) {
            return <code key={j} className="text-mauve bg-surface0/50 px-1 py-0.5 rounded text-[0.82rem]">{part.slice(1, -1)}</code>
          }
          return <span key={j}>{part}</span>
        })}
      </p>
    )
  })
}

export default function TipModal({ onClose, onNavigate }: Props) {
  // Subscribe to currentTipId so the modal re-renders when it changes
  const currentTipId = useTipsStore((s) => s.currentTipId)
  const dismissTip = useTipsStore((s) => s.dismissTip)
  const markTipActed = useTipsStore((s) => s.markTipActed)
  const pickNextTip = useTipsStore((s) => s.pickNextTip)
  const silenceUntilRestart = useTipsStore((s) => s.silenceUntilRestart)

  const current = useTipsStore.getState().getCurrentTip()
  if (!current) return null
  const { tip, content } = current
  const isMac = typeof window !== 'undefined' && window.electronPlatform === 'darwin'
  const body = resolveBody(content, isMac)
  const focusHint = resolveFocusHint(content, isMac)

  const handleAction = () => {
    markTipActed(tip.id)
    if (content.actionTarget && onNavigate) {
      onNavigate(content.actionTarget as ViewType)
    }
    onClose()
  }

  const handleDismiss = () => {
    dismissTip(tip.id)
    pickNextTip()
    onClose()
  }

  const handleNext = () => {
    pickNextTip()
    onClose()
  }

  const handleSilence = () => {
    silenceUntilRestart()
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-mantle rounded-lg shadow-2xl border border-surface0 w-full max-w-lg flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-3 flex items-start justify-between gap-4 border-b border-surface0">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <div className="text-mauve text-2xl mt-0.5" aria-hidden>💡</div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-overlay0 mb-0.5">
                {tip.category} · {tip.complexity}
              </div>
              <h2 className="text-base font-bold text-text">{content.title}</h2>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-overlay0 hover:text-text text-xl leading-none -mt-1 -mr-2 px-2 py-1"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-4 max-h-[50vh] overflow-y-auto">
          {renderBody(body)}

          {focusHint && (
            <div className="mt-3 p-2.5 rounded border border-mauve/30 bg-mauve/5 text-xs text-subtext0">
              <strong className="text-mauve">📍 Where to look:</strong> {focusHint}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-surface0 flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 text-xs">
            <button
              onClick={handleSilence}
              className="text-overlay0 hover:text-text transition-colors"
              title="Don't show tips again until next app restart"
            >
              Silence until restart
            </button>
            <span className="text-surface1">·</span>
            <button
              onClick={handleDismiss}
              className="text-overlay0 hover:text-red transition-colors"
              title="Never show this specific tip again"
            >
              Don't show this again
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleNext}
              className="px-3 py-1.5 text-sm text-overlay1 hover:text-text transition-colors"
            >
              Next tip
            </button>
            {content.actionLabel ? (
              <button
                onClick={handleAction}
                className="px-4 py-1.5 bg-mauve hover:bg-pink text-base font-medium rounded text-sm transition-colors"
              >
                {content.actionLabel}
              </button>
            ) : (
              <button
                onClick={() => { markTipActed(tip.id); onClose() }}
                className="px-4 py-1.5 bg-mauve hover:bg-pink text-base font-medium rounded text-sm transition-colors"
              >
                Got it
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
