import React, { useState } from 'react'
import { Session } from '../stores/sessionStore'
import { useRestartSession } from '../hooks/useRestartSession'
import NotesBar from './NotesBar'
import TipPill from './TipPill'

interface Props {
  session: Session
  isShowingPartner?: boolean
  sidebarCollapsed?: boolean
  onShowTip?: () => void
}

export default function SessionHeader({ session, isShowingPartner, sidebarCollapsed, onShowTip }: Props) {
  const [recoverMenu, setRecoverMenu] = useState<{ x: number; y: number } | null>(null)
  const { restart, recover: recoverSession } = useRestartSession(session, isShowingPartner)

  const handleRecover = () => {
    setRecoverMenu(null)
    recoverSession()
  }

  return (
    <div
      className="flex items-center gap-3 px-4 py-2 border-b border-surface0 bg-mantle shrink-0 relative"
    >
      {/* Session-color accent line that fades out toward the right —
          replaces the old flat 3px solid border. The gradient stops
          before fully transparent at ~70% so the colour reads strong
          on the left where the session label sits, and dissolves as
          it approaches the toolbar/right rail. */}
      <div
        className="absolute top-0 left-0 right-0 h-[2px] pointer-events-none"
        style={{ background: `linear-gradient(to right, ${session.color} 0%, ${session.color}80 15%, transparent 55%)` }}
        aria-hidden
      />
      {/* Color dot kept as the at-a-glance identifier — the session name lives
          in the tab strip directly above and was repeated here verbatim before.
          UX audit 2026-04-25: drop the redundant label, keep dot + metadata. */}
      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: session.color }} />
      <span className="text-xs text-overlay0">{session.model || 'default'}</span>
      {sidebarCollapsed && session.contextPercent != null && (
        <span className="text-xs text-overlay0">{Math.round(session.contextPercent)}%</span>
      )}
      {sidebarCollapsed && session.costUsd != null && (
        <span className="text-xs text-green">${session.costUsd.toFixed(2)}</span>
      )}
      {sidebarCollapsed && session.workingDirectory && (
        <span className="text-xs text-overlay0 truncate max-w-[120px]" title={session.workingDirectory}>
          {session.workingDirectory.split(/[/\\]/).filter(Boolean).pop() || session.workingDirectory}
        </span>
      )}
      {sidebarCollapsed && (
        <span className={`text-[10px] px-1 py-0.5 rounded font-medium ${
          session.shellOnly ? 'bg-surface1 text-overlay1' : 'bg-peach/20 text-peach'
        }`}>
          {session.shellOnly ? 'Shell' : 'Claude'}
        </span>
      )}
      {session.sessionType === 'ssh' && session.sshConfig && (
        <span className="text-xs text-mauve">SSH: {session.sshConfig.username}@{session.sshConfig.host}</span>
      )}
      {/* Separator before notes */}
      <div className="w-px h-4 bg-surface1" />

      {/* Secret notes */}
      <NotesBar configId={session.configId} />

      <div className="flex-1" />

      {onShowTip && <TipPill onClick={onShowTip} />}

      <button
        onClick={restart}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setRecoverMenu({ x: e.clientX, y: e.clientY })
        }}
        className="px-2.5 py-1 rounded text-xs font-medium text-overlay1 hover:text-text hover:bg-surface0 transition-colors"
        title={isShowingPartner ? 'Restart partner terminal (right-click to recover)' : 'Restart Claude session (right-click to recover)'}
      >
        Restart
      </button>

      {recoverMenu && (
        <RecoverContextMenu
          x={recoverMenu.x}
          y={recoverMenu.y}
          onClose={() => setRecoverMenu(null)}
          onRecover={handleRecover}
          isShowingPartner={isShowingPartner}
        />
      )}
    </div>
  )
}

function RecoverContextMenu({ x, y, onClose, onRecover, isShowingPartner }: {
  x: number; y: number
  onClose: () => void
  onRecover: () => void
  isShowingPartner?: boolean
}) {
  const menuRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top?: number; bottom?: number }>({ left: x })

  React.useEffect(() => {
    const el = menuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const viewH = window.innerHeight
    const viewW = window.innerWidth
    const left = Math.min(x, viewW - rect.width - 8)
    if (y + rect.height > viewH - 8) {
      setPos({ left, bottom: viewH - y })
    } else {
      setPos({ left, top: y })
    }
  }, [x, y])

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div
        ref={menuRef}
        className="fixed bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 min-w-[200px]"
        style={pos}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onRecover}
          className="w-full text-left px-3 py-1.5 text-xs text-yellow hover:bg-surface1 transition-colors flex items-center gap-2"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 4v6h6" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
          {isShowingPartner ? 'Recover Partner Terminal' : 'Recover All Terminals'}
        </button>
        <div className="px-3 py-1 text-[10px] text-overlay0">
          Force-kills all PTYs and respawns fresh.
          Use when a terminal has crashed (OOM, etc).
        </div>
      </div>
    </div>
  )
}
