import React from 'react'
import { Session, useSessionStore } from '../stores/sessionStore'
import { killSessionPty, clearSpawned } from '../ptyTracker'
import NotesBar from './NotesBar'

interface Props {
  session: Session
  isShowingPartner?: boolean
}

export default function SessionHeader({ session, isShowingPartner }: Props) {
  const updateSession = useSessionStore((s) => s.updateSession)

  const handleRestart = () => {
    if (isShowingPartner) {
      // Partner terminal: just kill partner PTY, leave main Claude untouched
      const partnerPtyId = session.id + '-partner'
      // Only kill the partner — don't use killSessionPty which also kills main+partner
      window.electronAPI.pty.kill(partnerPtyId)
      // Clear partner from spawn tracker so it respawns on remount
      clearSpawned(partnerPtyId)
      // Force re-mount by bumping createdAt
      const store = useSessionStore.getState()
      store.removeSession(session.id)
      store.addSession({ ...session, id: session.id, status: session.status, createdAt: Date.now() })
      return
    }
    // Kill the old PTY (also clears spawn tracker so new one will spawn)
    killSessionPty(session.id)
    // NO resume picker on restart — user already has their session, just restart Claude directly.
    // Resume picker is only for initial launch from sidebar.
    // Force re-mount with clean metadata
    const store = useSessionStore.getState()
    store.removeSession(session.id)
    store.addSession({
      ...session,
      id: session.id,
      status: 'idle',
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
      compactionInterruptTriggered: undefined,
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
      {session.sessionType === 'ssh' && session.sshConfig && (
        <span className="text-xs text-mauve">SSH: {session.sshConfig.username}@{session.sshConfig.host}</span>
      )}

      {/* Separator before notes */}
      <div className="w-px h-4 bg-surface1" />

      {/* Secret notes */}
      <NotesBar configId={session.configId} />

      <div className="flex-1" />

      <button
        onClick={handleRestart}
        className="px-2.5 py-1 rounded text-xs font-medium text-overlay1 hover:text-text hover:bg-surface0 transition-colors"
        title={isShowingPartner ? 'Restart partner terminal' : 'Restart Claude session'}
      >
        Restart
      </button>
    </div>
  )
}
