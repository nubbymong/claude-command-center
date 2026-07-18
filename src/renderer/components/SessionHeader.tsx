import React from 'react'
import { Session, useSessionStore } from '../stores/sessionStore'
import NotesBar from './NotesBar'
import TipPill from './TipPill'
import { resolveIdentityColor, bucketLegacyColorToKey } from '../../shared/identity-colors'
import { useResolvedTheme } from '../hooks/useThemeController'
import { useRegionTypography } from '../hooks/useTypography'

interface Props {
  session: Session
  onShowTip?: () => void
}

/**
 * Click-to-edit session "work name" for the active session. Shows the current
 * display name (customName || label); clicking swaps to an input that commits
 * on Enter/blur and cancels on Esc. Blank commit reverts to the config label.
 *
 * Uses LOCAL edit state (not the store's renamingSessionId, which drives the
 * tab-bar editor) so triggering rename from the tab/F2 doesn't also pop an
 * editor open here — each surface opens independently, all writing customName.
 */
function SessionNameField({ session }: { session: Session }) {
  const renameSession = useSessionStore((s) => s.renameSession)
  const [editing, setEditing] = React.useState(false)
  const name = session.customName?.trim() || session.label
  const ref = React.useRef<HTMLInputElement>(null)
  const doneRef = React.useRef(false)

  React.useEffect(() => {
    if (!editing) return
    doneRef.current = false
    const el = ref.current
    if (el) { el.focus(); el.select() }
  }, [editing])

  if (editing) {
    return (
      <input
        ref={ref}
        type="text"
        defaultValue={name}
        maxLength={80}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') { doneRef.current = true; renameSession(session.id, (e.currentTarget as HTMLInputElement).value); setEditing(false) }
          else if (e.key === 'Escape') { doneRef.current = true; setEditing(false) }
        }}
        onBlur={(e) => {
          if (doneRef.current) return
          doneRef.current = true
          renameSession(session.id, (e.currentTarget as HTMLInputElement).value)
          setEditing(false)
        }}
        className="min-w-0 max-w-[240px] bg-transparent outline-none border-b border-current text-text text-xs font-medium"
        aria-label="Session name"
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title={`${name} — click to rename`}
      className="max-w-[240px] truncate text-xs font-medium text-text hover:text-mauve transition-colors focus-ring rounded px-0.5"
    >
      {name}
    </button>
  )
}

export default function SessionHeader({ session, onShowTip }: Props) {
  const theme = useResolvedTheme()
  const headerType = useRegionTypography('header')
  // Resolve identity per-theme (like every other migrated surface) so the accent
  // theme-shifts and a pre-migration reserved hue never leaks through.
  const identity = resolveIdentityColor(session.identityColorKey ?? bucketLegacyColorToKey(session.color), theme)
  // Orientation info folded in from the former standalone RepoBreadcrumb strip:
  // working directory (middle) + GitHub repo slug/connection (right). One bar
  // instead of two.
  const cwd = session.workingDirectory || ''
  const gi = session.githubIntegration
  const slug = gi?.repoSlug
  const connected = !!gi?.enabled && !!slug
  return (
    <div
      className="flex items-center gap-3 px-4 py-2 border-b shrink-0 relative"
      style={{ background: 'var(--surface-panel)', borderColor: 'var(--border-subtle)', ...headerType }}
    >
      {/* Session-color accent line that fades out toward the right --
          the gradient stops before fully transparent at ~70% so the
          colour reads strong on the left and dissolves toward the right. */}
      <div
        className="absolute top-0 left-0 right-0 h-[2px] pointer-events-none"
        style={{ background: `linear-gradient(to right, ${identity} 0%, ${identity}80 15%, transparent 55%)` }}
        aria-hidden
      />
      {/* Color dot: at-a-glance session identifier */}
      <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: identity }} />

      {/* Editable work name for this session (F2 / double-click tab / here). */}
      <SessionNameField session={session} />

      {/* Working directory — flexible middle, truncates first on narrow widths.
          (Passive orientation, no actions — formerly RepoBreadcrumb.) */}
      <span className="font-mono text-[11px] truncate min-w-0 flex-1" style={{ color: 'var(--text-muted)' }} title={cwd}>
        {cwd}
      </span>

      {session.sessionType === 'ssh' && session.sshConfig && (
        <span className="text-xs text-mauve shrink-0">SSH: {session.sshConfig.username}@{session.sshConfig.host}</span>
      )}

      {/* GitHub repo slug + connection state (right cluster, formerly RepoBreadcrumb). */}
      {slug && (
        <span className="flex items-center gap-1.5 shrink-0 text-[11px]" style={{ color: 'var(--text-muted)' }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2C6.48 2 2 6.48 2 12c0 4.42 2.87 8.17 6.84 9.5.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.6 9.6 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 22 12c0-5.52-4.48-10-10-10z"/></svg>
          <span className="truncate max-w-[180px]" title={gi?.repoUrl || slug}>{slug}</span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: connected ? 'var(--status-success)' : 'var(--text-muted)' }} aria-hidden />
            <span style={{ color: connected ? 'var(--status-success)' : 'var(--text-muted)' }}>{connected ? 'connected' : 'detected'}</span>
          </span>
        </span>
      )}

      {/* Separator before notes */}
      <div className="w-px h-4 bg-surface1 shrink-0" />

      {/* Secret notes */}
      <NotesBar configId={session.configId} />

      {onShowTip && <TipPill onClick={onShowTip} />}
    </div>
  )
}
