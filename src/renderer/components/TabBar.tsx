import React from 'react'
import { requestCloseSession } from '../stores/sshCloseStore'
import { useSessionStore } from '../stores/sessionStore'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import { useRegionTypography } from '../hooks/useTypography'
import { ViewType } from '../types/views'
import { PAGE_TAB_META } from '../page-tab-meta'
import { BrandMark } from './BrandMark'
import { useCanvasQueue } from '../lib/canvasQueue'
import { useCanvasTotalsStore } from '../stores/canvasTotalsStore'

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
 * The waiting-on-you mark (#364/#366, owner pick B): a small warning-colour
 * dot on the session tab while that session's canvas review queue is
 * non-empty — the same number the Canvas button wears, so the tab can be
 * found from across the app. Its own component because the queue is a hook
 * and tabs render in a loop; it hydrates the cross-canvas sweep lazily so a
 * background session's owed rounds count without its pane ever having opened.
 */
function TabCanvasQueueMark({ sessionId }: { sessionId: string }) {
  const queue = useCanvasQueue(sessionId)
  const totalsLoaded = useCanvasTotalsStore((s) => !!s.bySessionId[sessionId]?.loaded)
  const scheduleRefresh = useCanvasTotalsStore((s) => s.scheduleRefresh)
  // Debounced, not immediate: every tab hydrates its own session's sweep and
  // each sweep is synchronous file reads in main, so a window full of tabs
  // must coalesce with the push-driven refreshes instead of stampeding at
  // mount. Boot-time cost is bounded (canvases per session are capped).
  React.useEffect(() => {
    if (!totalsLoaded) scheduleRefresh(sessionId)
  }, [sessionId, totalsLoaded, scheduleRefresh])
  if (queue === 0) return null
  return (
    <span
      className="shrink-0 w-[7px] h-[7px] rounded-full relative z-10"
      style={{ background: 'var(--status-warning)' }}
      title={`${queue} canvas${queue === 1 ? '' : 'es'} waiting on you`}
      aria-label={`${queue} canvas${queue === 1 ? '' : 'es'} waiting on you`}
      data-testid="tab-canvas-queue-mark"
    />
  )
}

/**
 * The glyph at the head of a session tab. Every session gets its identity dot;
 * the Ask Conductor session gets the app monogram instead, because it is the
 * app answering rather than one of your projects. Rendered from ONE helper so
 * the normal and inline-rename branches cannot drift apart.
 */
function TabGlyph({ kind, color }: { kind?: 'ask'; color: string }) {
  if (kind === 'ask') {
    return <BrandMark className="w-[13px] h-[13px] shrink-0 relative z-10" />
  }
  return (
    <span
      className="w-1.5 h-1.5 rounded-full shrink-0 relative z-10"
      style={{ backgroundColor: color }}
      aria-hidden
    />
  )
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

interface TabBarProps {
  /** The current main-pane view. When it is a page (not 'sessions'), no session
   *  tab is the active one — the active tab is a page tab. */
  activeView: ViewType
  /** Pages currently open as tabs, in open order, rendered after the sessions. */
  openPageTabs: ViewType[]
  /** Activate a session tab (switches the pane back to sessions). */
  onActivateSession: (id: string) => void
  /** Activate an already-open page tab. */
  onActivatePage: (v: ViewType) => void
  /** Close a page tab. */
  onClosePage: (v: ViewType) => void
}

export default function TabBar({ activeView, openPageTabs, onActivateSession, onActivatePage, onClosePage }: TabBarProps) {
  const { sessions, activeSessionId } = useSessionStore()
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

  if (sessions.length === 0 && openPageTabs.length === 0) return null

  const closeSession = (id: string) => {
    // item 4: a persistent SSH session gets the End-vs-Leave-running choice.
    requestCloseSession(id)
  }

  return (
    <div className="flex items-center shrink-0" style={{ background: 'var(--surface-panel)', borderBottom: '1px solid var(--border-subtle)', ...headerType }}>
      <div className="flex items-center overflow-x-auto flex-1 min-w-0">
      {sessions.map((session) => {
        const needsAttention = session.needsAttention && !(activeSessionId === session.id && activeView === 'sessions')
        const isActive = activeSessionId === session.id && activeView === 'sessions'
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
                <TabGlyph kind={session.kind} color={color} />
                <TabLabelEditor
                  initial={name}
                  onCommit={(v) => renameSession(session.id, v)}
                  onCancel={() => beginRename(null)}
                />
              </div>
            ) : (
              <button
                data-testid="session-tab"
                onClick={() => onActivateSession(session.id)}
                onDoubleClick={() => beginRename(session.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  onActivateSession(session.id)
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
                {/* Identity dot -- resolves to the same tint as the active
                    background. The Ask session wears the app monogram here. */}
                <TabGlyph kind={session.kind} color={color} />
                <span className="truncate max-w-[120px] relative z-10">{name}</span>
                <TabCanvasQueueMark sessionId={session.id} />
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
      {/* Page tabs — the nav-rail pages (Tokenomics, Logs, Feature Guide, …)
          opened as tabs. They sit after the session tabs in open order, use the
          app accent rather than a per-session identity colour, and carry the
          same close affordance. */}
      {openPageTabs.map((v) => {
        const meta = PAGE_TAB_META[v]
        if (!meta) return null
        const isActive = activeView === v
        return (
          <div key={`page:${v}`} className="group relative inline-flex items-center mt-1 mx-0.5 shrink-0">
            <button
              data-testid="page-tab"
              data-page={v}
              onClick={() => onActivatePage(v)}
              aria-label={meta.label}
              aria-current={isActive ? 'page' : undefined}
              title={meta.label}
              className={`relative flex items-center gap-2 pl-3 pr-7 py-1.5 text-xs rounded-t-lg transition-all duration-150 overflow-hidden focus-ring ${isActive ? 'text-text' : 'text-overlay1 hover:text-text'}`}
              style={{ backgroundColor: isActive ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : undefined }}
              onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.backgroundColor = 'color-mix(in srgb, var(--accent) 9%, transparent)' }}
              onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
            >
              <span className="shrink-0 relative z-10 flex items-center" style={{ color: isActive ? 'var(--accent)' : 'var(--text-muted)' }}>{meta.icon}</span>
              <span className="truncate max-w-[140px] relative z-10">{meta.label}</span>
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClosePage(v) }}
              aria-label={`Close ${meta.label}`}
              title={`Close ${meta.label}`}
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
            className="w-full text-left px-3 py-1.5 text-[var(--text-primary)] hover:bg-[var(--surface-overlay)]"
            onClick={() => { const id = menu.id; setMenu(null); beginRename(id) }}
          >
            Rename&hellip;
          </button>
          <button
            type="button"
            role="menuitem"
            className="w-full text-left px-3 py-1.5 text-[var(--text-primary)] hover:bg-[var(--surface-overlay)] hover:text-[var(--status-danger)]"
            onClick={() => { const id = menu.id; setMenu(null); closeSession(id) }}
          >
            Close
          </button>
        </div>
      )}
    </div>
  )
}
