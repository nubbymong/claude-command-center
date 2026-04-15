import React from 'react'
import TerminalView from '../TerminalView'
import { useSessionStore } from '../../stores/sessionStore'
import type { PaneComponentProps } from './PaneRegistry'

export default function TerminalPane({ paneId, paneType, sessionId, isActive, props }: PaneComponentProps) {
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  if (!session) return null

  const isPartner = paneType === 'partner-terminal'
  const ptySessionId = isPartner ? `${sessionId}-partner` : sessionId

  return (
    <TerminalView
      key={ptySessionId + '-' + session.createdAt}
      sessionId={ptySessionId}
      configId={session.configId}
      cwd={isPartner ? (session.partnerTerminalPath || session.workingDirectory) : (session.sessionType === 'local' ? session.workingDirectory : undefined)}
      shellOnly={isPartner ? true : session.shellOnly}
      elevated={isPartner ? session.partnerElevated : undefined}
      ssh={isPartner ? undefined : session.sshConfig}
      isActive={isActive}
      legacyVersion={isPartner ? undefined : session.legacyVersion}
      agentIds={isPartner ? undefined : session.agentIds}
      flickerFree={isPartner ? undefined : session.flickerFree}
      powershellTool={isPartner ? undefined : session.powershellTool}
      effortLevel={isPartner ? undefined : session.effortLevel}
      disableAutoMemory={isPartner ? undefined : session.disableAutoMemory}
    />
  )
}
