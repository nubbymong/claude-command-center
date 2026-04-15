import React, { useState, useEffect } from 'react'
import { Session, useSessionStore } from '../stores/sessionStore'
import { killSessionPty, clearSpawned } from '../ptyTracker'
import { markSessionForResumePicker } from '../utils/resumePicker'
import NotesBar from './NotesBar'
import TipPill from './TipPill'
import { usePanelStore } from '../stores/panelStore'
import { getAllPaneIds } from '../utils/panel-layout'
import type { PaneType } from '../../shared/types'

interface Props {
  session: Session
  sidebarCollapsed?: boolean
  onShowTip?: () => void
}

export default function SessionHeader({ session, sidebarCollapsed, onShowTip }: Props) {
  const updateSession = useSessionStore((s) => s.updateSession)
  const [recoverMenu, setRecoverMenu] = useState<{ x: number; y: number } | null>(null)
  const [viewsMenu, setViewsMenu] = useState(false)
  const [diffStats, setDiffStats] = useState<{ added: number; removed: number } | null>(null)
  const layout = usePanelStore((s) => s.layouts[session.id])

  useEffect(() => {
    if (!session.workingDirectory) return

    const fetchStats = async () => {
      try {
        const stats = await window.electronAPI.diff.getStats(session.id, session.workingDirectory)
        if (stats.added > 0 || stats.removed > 0) {
          setDiffStats(stats)
        } else {
          setDiffStats(null)
        }
      } catch { setDiffStats(null) }
    }

    fetchStats()
    const interval = setInterval(fetchStats, 5000)
    return () => clearInterval(interval)
  }, [session.id, session.workingDirectory])

  const addPane = (paneType: PaneType) => {
    setViewsMenu(false)
    if (!layout) return
    const paneIds = getAllPaneIds(layout)
    if (paneIds.length === 0) return
    usePanelStore.getState().addPane(session.id, paneIds[0], paneType, 'horizontal')
  }

  const resetLayout = () => {
    setViewsMenu(false)
    usePanelStore.getState().resetLayout(session.id, window.innerWidth)
  }

  const handleRestart = () => {
    // Kill the old PTY (also clears spawn tracker so new one will spawn)
    killSessionPty(session.id)
    // Show resume picker on restart so user can pick a conversation
    if (session.sessionType === 'local' && !session.shellOnly) {
      markSessionForResumePicker(session.id)
    }
    // Force re-mount with clean metadata
    forceRemount('idle')
  }

  // Aggressive recovery: kill ALL PTYs (main + partner), clear ALL spawn trackers, force remount.
  // Use when a PTY process has crashed (OOM, etc.) and normal restart can't recover.
  const handleRecover = () => {
    setRecoverMenu(null)
    const partnerPtyId = session.id + '-partner'
    // Kill both main and partner PTYs (ignore errors — process may already be dead)
    window.electronAPI.pty.kill(session.id)
    window.electronAPI.pty.kill(partnerPtyId)
    clearSpawned(session.id)
    clearSpawned(partnerPtyId)
    // Show resume picker for Claude sessions
    if (session.sessionType === 'local' && !session.shellOnly) {
      markSessionForResumePicker(session.id)
    }
    forceRemount('idle')
  }

  const forceRemount = (status: 'idle' | 'working') => {
    const store = useSessionStore.getState()
    store.removeSession(session.id)
    store.addSession({
      ...session,
      id: session.id,
      status,
      createdAt: Date.now(),
      // Clear stale metadata from previous run
      contextPercent: undefined,
      costUsd: undefined,
      needsAttention: false,
      modelName: undefined,
      linesAdded: undefined,
      linesRemoved: undefined,
      inputTokens: undefined,
      outputTokens: undefined,
      totalDurationMs: undefined,
      rateLimitCurrent: undefined,
      rateLimitCurrentResets: undefined,
      rateLimitWeekly: undefined,
      rateLimitWeeklyResets: undefined,
      rateLimitExtra: undefined,
    })
  }

  return (
    <div
      className="flex items-center gap-3 px-4 py-2 border-b border-surface0 bg-mantle shrink-0"
      style={{ borderTopWidth: '3px', borderTopStyle: 'solid', borderTopColor: session.color }}
    >
      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: session.color }} />
      <span className="font-medium text-sm text-text">{session.label}</span>
      <span className="text-xs text-overlay0">{session.model || 'default'}</span>
      {diffStats && (
        <button
          onClick={() => addPane('diff-viewer')}
          className="text-xs px-1.5 py-0.5 rounded bg-surface0 hover:bg-surface1 transition-colors transition-opacity duration-200 flex items-center gap-1"
          title="Open Diff Viewer"
        >
          <span className="text-green">+{diffStats.added}</span>
          <span className="text-red">-{diffStats.removed}</span>
        </button>
      )}
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

      <div className="relative ml-auto">
        <button
          onClick={() => setViewsMenu(!viewsMenu)}
          className="text-xs text-overlay1 hover:text-text px-2 py-0.5 rounded hover:bg-surface0 transition-colors"
        >
          Views
        </button>
        {viewsMenu && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setViewsMenu(false)} />
            <div className="absolute right-0 top-full mt-1 bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 z-50 min-w-[160px]">
              <button onClick={() => addPane('diff-viewer')} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors">
                Diff Viewer
              </button>
              <button onClick={() => addPane('preview')} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors">
                Preview
              </button>
              <button onClick={() => addPane('file-editor')} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors">
                File Editor
              </button>
              <button onClick={() => addPane('partner-terminal')} className="w-full text-left px-3 py-1.5 text-xs text-text hover:bg-surface1 transition-colors">
                Partner Terminal
              </button>
              <div className="border-t border-surface1 my-1" />
              <button onClick={resetLayout} className="w-full text-left px-3 py-1.5 text-xs text-overlay1 hover:bg-surface1 transition-colors">
                Reset Layout
              </button>
            </div>
          </>
        )}
      </div>

      <button
        onClick={handleRestart}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setRecoverMenu({ x: e.clientX, y: e.clientY })
        }}
        className="px-2.5 py-1 rounded text-xs font-medium text-overlay1 hover:text-text hover:bg-surface0 transition-colors"
        title="Restart Claude session (right-click to recover)"
      >
        Restart
      </button>

      {recoverMenu && (
        <RecoverContextMenu
          x={recoverMenu.x}
          y={recoverMenu.y}
          onClose={() => setRecoverMenu(null)}
          onRecover={handleRecover}
        />
      )}
    </div>
  )
}

function RecoverContextMenu({ x, y, onClose, onRecover }: {
  x: number; y: number
  onClose: () => void
  onRecover: () => void
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
          Recover All Terminals
        </button>
        <div className="px-3 py-1 text-[10px] text-overlay0">
          Force-kills all PTYs and respawns fresh.
          Use when a terminal has crashed (OOM, etc).
        </div>
      </div>
    </div>
  )
}
