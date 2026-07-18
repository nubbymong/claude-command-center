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

/** The session's display name: user-assigned work name, else the config label. */
function displayNameOf(s: { customName?: string; label: string }): string {
  return s.customName?.trim() || s.label
}

/**
 * Inline rename editor rendered in place of the tab label while the session is
 * being renamed. Seeds with the current display name, selects-all on mount,
 * commits on Enter/blur, cancels on Esc. Blank commit clears the override
 * (renameSession reverts to the config label).
 */
function TabLabelEditor({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  // Guard so a blur triggered BY Enter/Esc doesn't double-fire a commit.
  const doneRef = React.useRef(false)

  React.useEffect(() => {
    const el = ref.current
    if (el) {
      el.focus()
      el.select()
    }
  }, [])

  return (
    <input
      ref={ref}
      type="text"
      defaultValue={initial}
      maxLength={80}
      // Clicks inside the field must not bubble to the tab button (which would
      // switch/deselect) — keep focus in the editor.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          doneRef.current = true
          onCommit((e.currentTarget as HTMLInputElement).value)
        } else if (e.key === 'Escape') {
          doneRef.current = true
          onCancel()
        }
      }}
      onBlur={(e) => {
        if (doneRef.current) return
        doneRef.current = true
        onCommit((e.currentTarget as HTMLInputElement).value)
      }}
      className="relative z-10 min-w-0 max-w-[120px] bg-transparent outline-none border-b border-current text-inherit"
      style={{ font: 'inherit' }}
      aria-label="Session name"
    />
  )
}

export default function TabBar() {
  const { sessions, activeSessionId, setActiveSession, removeSession } = useSessionStore()
  const renamingSessionId = useSessionStore((s) => s.renamingSessionId)
  const beginRename = useSessionStore((s) => s.beginRename)
  const renameSession = useSessionStore((s) => s.renameSession)
  const theme = useResolvedTheme()
  const headerType = useRegionTypography('header')

  // Right-click context menu (screen-positioned, one at a time).
  const [menu, setMenu] = React.useState<{ id: string; x: number; y: number } | null>(null)

  // Inject styles on first render
  React.useEffect(() => {
    injectAttentionStyles()
  }, [])

  // Dismiss the context menu on any outside interaction / Esc.
  React.useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  if (sessions.length === 0) return null

  const closeSession = (id: string) => {
    killSessionPty(id)
    removeSession(id)
  }

  return (
    <div className="flex items-center shrink-0" style={{ background: 'var(--surface-panel)', borderBottom: '1px solid var(--border-subtle)', ...headerType }}>
      <div className="flex items-center overflow-x-auto flex-1 min-w-0">
      {sessions.map((session) => {
        const needsAttention = session.needsAttention && activeSessionId !== session.id
        const isActive = activeSessionId === session.id
        const color = resolveIdentityColor(session.identityColorKey ?? bucketLegacyColorToKey(session.color), theme)
        const name = displayNameOf(session)
        const isRenaming = renamingSessionId === session.id
        // Tooltip reveals the origin (config label + cwd) that the tab no longer
        // shows once a custom name is set.
        const originLine = session.customName?.trim() ? `${session.label} · ${session.workingDirectory}` : session.workingDirectory
        const tabTitle = `${name}\n${originLine}`

        return (
          // Wrapper div carries `group` so hover-reveal on close button works.
          // The close button is a SIBLING of the tab button -- not a descendant --
          // so there are no nested interactive elements (invalid HTML).
          <div
            key={session.id}
            className="group relative inline-flex items-center mt-1 mx-0.5 shrink-0"
          >
            {isRenaming ? (
              // While renaming, the tab is a plain container (NOT a <button>) so
              // the <input> isn't nested in interactive content (invalid HTML +
              // flaky focus in Chromium).
              <div
                className="relative flex items-center gap-2 pl-4 pr-7 py-1.5 text-xs rounded-t-lg overflow-hidden text-text"
                style={{ backgroundColor: color + '20' }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full shrink-0 relative z-10"
                  style={{ backgroundColor: color }}
                  aria-hidden
                />
                <TabLabelEditor
                  initial={name}
                  onCommit={(v) => renameSession(session.id, v)}
                  onCancel={() => beginRename(null)}
                />
              </div>
            ) : (
              <button
                onClick={() => setActiveSession(session.id)}
                onDoubleClick={() => beginRename(session.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setActiveSession(session.id)
                  setMenu({ id: session.id, x: e.clientX, y: e.clientY })
                }}
                aria-label={name}
                title={tabTitle}
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
                <span className="truncate max-w-[120px] relative z-10">{name}</span>
              </button>
            )}
            {/* Close button is a sibling of the tab button, absolutely positioned
                at the right edge of the wrapper. stopPropagation prevents the
                underlying tab button's click from firing. */}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                closeSession(session.id)
              }}
              aria-label={`Close ${name}`}
              title={`Close ${name}`}
              className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 hover:text-red transition-opacity cursor-pointer z-20 focus-ring rounded"
            >
              &times;
            </button>
          </div>
        )
      })}
      </div>

      {/* Right-click context menu. Fixed-positioned at the cursor; dismissed via
          the window listeners above (mousedown/Esc/resize/blur). */}
      {menu && (
        <div
          className="fixed z-50 min-w-[140px] rounded-md py-1 shadow-xl text-xs"
          style={{
            left: menu.x,
            top: menu.y,
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-subtle)',
          }}
          // Keep clicks inside the menu from hitting the window mousedown-to-close.
          onMouseDown={(e) => e.stopPropagation()}
          role="menu"
        >
          <button
            type="button"
            role="menuitem"
            className="w-full text-left px-3 py-1.5 text-text hover:bg-surface0"
            onClick={() => { const id = menu.id; setMenu(null); beginRename(id) }}
          >
            Rename&hellip;
          </button>
          <button
            type="button"
            role="menuitem"
            className="w-full text-left px-3 py-1.5 text-text hover:bg-surface0 hover:text-red"
            onClick={() => { const id = menu.id; setMenu(null); closeSession(id) }}
          >
            Close
          </button>
        </div>
      )}
    </div>
  )
}
