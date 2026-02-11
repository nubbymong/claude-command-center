import React from 'react'
import { Session, useSessionStore } from '../stores/sessionStore'
import { killSessionPty } from '../ptyTracker'

interface Props {
  session: Session
}

export default function SessionHeader({ session }: Props) {
  const updateSession = useSessionStore((s) => s.updateSession)

  const handleRestart = () => {
    // Kill the old PTY (also clears spawn tracker so new one will spawn)
    killSessionPty(session.id)
    // Force re-mount by removing and re-adding with new createdAt
    const store = useSessionStore.getState()
    store.removeSession(session.id)
    store.addSession({ ...session, id: session.id, status: 'idle', createdAt: Date.now() })
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

      <div className="flex-1" />

      <button
        onClick={handleRestart}
        className="px-2.5 py-1 rounded text-xs font-medium text-overlay1 hover:text-text hover:bg-surface0 transition-colors"
        title="Restart Claude session"
      >
        Restart
      </button>
    </div>
  )
}
