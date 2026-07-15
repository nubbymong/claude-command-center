import React from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { killSessionPty } from './TerminalView'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import { useRegionTypography } from '../hooks/useTypography'

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
  const theme = useResolvedTheme()
  const headerType = useRegionTypography('header')

  // Inject styles on first render
  React.useEffect(() => {
    injectAttentionStyles()
  }, [])

  if (sessions.length === 0) return null

  return (
    <div className="flex items-center shrink-0" style={{ background: 'var(--surface-panel)', borderBottom: '1px solid var(--border-subtle)', ...headerType }}>
      <div className="flex items-center overflow-x-auto flex-1 min-w-0">
      {sessions.map((session) => {
        const needsAttention = session.needsAttention && activeSessionId !== session.id
        const isActive = activeSessionId === session.id
        const color = resolveIdentityColor(session.identityColorKey ?? bucketLegacyColorToKey(session.color), theme)

        return (
          // Wrapper div carries `group` so hover-reveal on close button works.
          // The close button is a SIBLING of the tab button -- not a descendant --
          // so there are no nested interactive elements (invalid HTML).
          <div
            key={session.id}
            className="group relative inline-flex items-center mt-1 mx-0.5 shrink-0"
          >
            <button
              onClick={() => setActiveSession(session.id)}
              aria-label={session.label}
              className={`relative flex items-center gap-2 pl-4 pr-7 py-1.5 text-xs rounded-t-lg transition-all duration-150 overflow-hidden focus-ring ${
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
              {/* Identity dot -- resolves to the same tint as the active background */}
              <span
                className="w-1.5 h-1.5 rounded-full shrink-0 relative z-10"
                style={{ backgroundColor: color }}
                aria-hidden
              />
              <span className="truncate max-w-[120px] relative z-10">{session.label}</span>
            </button>
            {/* Close button is a sibling of the tab button, absolutely positioned
                at the right edge of the wrapper. stopPropagation prevents the
                underlying tab button's click from firing. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                killSessionPty(session.id)
                removeSession(session.id)
              }}
              aria-label={`Close ${session.label}`}
              title={`Close ${session.label}`}
              className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 hover:text-red transition-opacity cursor-pointer z-20 focus-ring rounded"
            >
              &times;
            </button>
          </div>
        )
      })}
      </div>
    </div>
  )
}
