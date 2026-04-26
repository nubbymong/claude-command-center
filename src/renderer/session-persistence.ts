import { useSessionStore } from './stores/sessionStore'
import type { SessionState, SavedSession } from './types/electron'

// Serialize the current sessionStore into the shape the main process persists.
// Previously lived inline in App.tsx but the GitHub per-session config save
// path needs it too: main's GITHUB_SESSION_CONFIG_UPDATE handler looks sessions
// up in session-state.json, which is only written on graceful close. Fresh
// sessions would fail with "not-found". Callers now flush via session.save
// before invoking session-scoped IPC to keep the on-disk view in sync.
export function buildSessionState(): SessionState {
  const state = useSessionStore.getState()
  const sessions: SavedSession[] = state.sessions.map((s) => ({
    id: s.id,
    configId: s.configId,
    label: s.label,
    workingDirectory: s.workingDirectory,
    model: s.model,
    color: s.color,
    sessionType: s.sessionType,
    shellOnly: s.shellOnly,
    partnerTerminalPath: s.partnerTerminalPath,
    partnerElevated: s.partnerElevated,
    sshConfig: s.sshConfig
      ? {
          host: s.sshConfig.host,
          port: s.sshConfig.port,
          username: s.sshConfig.username,
          remotePath: s.sshConfig.remotePath,
          hasPassword: s.sshConfig.hasPassword,
          postCommand: s.sshConfig.postCommand,
          hasSudoPassword: s.sshConfig.hasSudoPassword,
          dockerContainer: s.sshConfig.dockerContainer,
        }
      : undefined,
    legacyVersion: s.legacyVersion,
    agentIds: s.agentIds,
    githubIntegration: s.githubIntegration,
  }))
  return {
    sessions,
    activeSessionId: state.activeSessionId,
    savedAt: Date.now(),
  }
}
