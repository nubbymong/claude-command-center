import React from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { killSessionPty } from './TerminalView'
import HeaderCluster from './HeaderCluster'

// Inject keyframes for attention pulse animation
const ATTENTION_STYLES_ID = 'attention-pulse-styles'
function injectAttentionStyles() {
  if (document.getElementById(ATTENTION_STYLES_ID)) return
  const style = document.createElement('style')
  style.id = ATTENTION_STYLES_ID
  style.textContent = `
    @keyframes attention-pulse {
      0%, 100% { opacity: 0; }
      50% { opacity: 0.35; }
    }
    .attention-pulse-bg {
      animation: attention-pulse 2s ease-in-out infinite;
    }
  `
  document.head.appendChild(style)
}

export default function TabBar() {
  const { sessions, activeSessionId, setActiveSession, removeSession } = useSessionStore()

  // Inject styles on first render
  React.useEffect(() => {
    injectAttentionStyles()
  }, [])

  if (sessions.length === 0) return null

  return (
    <div className="flex items-center bg-crust border-b border-surface0 shrink-0">
      <div className="flex items-center overflow-x-auto flex-1 min-w-0">
      {sessions.map((session) => {
        const needsAttention = session.needsAttention && activeSessionId !== session.id
        const isActive = activeSessionId === session.id
        const color = session.color

        return (
          <button
            key={session.id}
            onClick={() => setActiveSession(session.id)}
            className={`group relative flex items-center gap-2 px-4 py-1.5 mt-1 mx-0.5 text-xs rounded-t-lg transition-all duration-150 shrink-0 overflow-hidden ${
              isActive
                ? 'text-text'
                : 'text-overlay1 hover:text-text'
            }`}
            style={{
              backgroundColor: isActive ? color + '20' : undefined,
            }}
            onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.backgroundColor = color + '12' }}
            onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
          >
            {/* Attention pulse background */}
            {needsAttention && (
              <div
                className="absolute inset-0 attention-pulse-bg"
                style={{ backgroundColor: color }}
              />
            )}
            <span className="truncate max-w-[120px] relative z-10">{session.label}</span>
            <span
              onClick={(e) => {
                e.stopPropagation()
                killSessionPty(session.id)
                removeSession(session.id)
              }}
              className="ml-1 opacity-0 group-hover:opacity-100 hover:text-red transition-opacity cursor-pointer relative z-10"
            >
              &times;
            </span>
          </button>
        )
      })}
      </div>
      {/* Right slot — global toggles (theme + future help-inspect). Same
          cluster lives in <PageFrame> so switching from a session to an
          admin view keeps these controls in the same place. */}
      <div className="flex items-center px-2 shrink-0 border-l border-surface0">
        <HeaderCluster />
      </div>
    </div>
  )
}
