import React from 'react'

interface ScrollToBottomButtonProps {
  onClick: () => void
}

export default function ScrollToBottomButton({ onClick }: ScrollToBottomButtonProps) {
  return (
    <button
      onClick={onClick}
      className="absolute right-4 bottom-24 z-20 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-blue/90 text-crust text-xs font-medium shadow-lg hover:bg-blue transition-colors cursor-pointer"
      title="Scroll to bottom"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 12 15 18 9" />
      </svg>
      Live
    </button>
  )
}
