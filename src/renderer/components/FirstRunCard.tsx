import React from 'react'

interface Props {
  onGetStarted: () => void
  onDismiss: () => void
}

/**
 * Sidebar card shown to first-run users with no configs.
 * Visually similar to the Update Available card but positioned
 * in the Active Sessions area.
 */
export default function FirstRunCard({ onGetStarted, onDismiss }: Props) {
  return (
    <div className="mx-2 mb-2 rounded-lg border border-mauve/30 bg-gradient-to-br from-mauve/10 to-blue/5 p-3 relative group">
      <button
        onClick={onDismiss}
        className="absolute top-1 right-1 w-5 h-5 flex items-center justify-center text-overlay0 hover:text-text opacity-0 group-hover:opacity-100 transition-opacity text-sm leading-none"
        title="Dismiss"
      >
        ×
      </button>

      <div className="flex items-start gap-2 mb-2">
        <div className="text-mauve mt-0.5 shrink-0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4-6.2-4.5-6.2 4.5 2.4-7.4L2 9.4h7.6L12 2z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-text">Get Started</div>
          <div className="text-[11px] text-subtext0 leading-snug mt-0.5">
            Create your first terminal config
          </div>
        </div>
      </div>

      <button
        onClick={onGetStarted}
        className="w-full px-3 py-1.5 bg-mauve hover:bg-pink text-base font-medium rounded text-xs transition-colors"
      >
        Create Config
      </button>
    </div>
  )
}
