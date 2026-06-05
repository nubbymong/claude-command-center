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
    color: s.color,
    identityColorKey: s.identityColorKey,
    legacyColor: s.legacyColor,
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
        }
      : undefined,
    machineName: s.machineName,
    githubIntegration: s.githubIntegration,
    // v1.5: provider-shape persistence. Codex sessions (P2.8+) carry
    // provider='codex' + codexOptions; Claude sessions stay on the legacy
    // top-level fields packed into claudeOptions below.
    provider: s.provider ?? 'claude',
    profileId: s.profileId,
    claudeOptions: (s.provider ?? 'claude') === 'claude' ? {
      model: s.model || undefined,
      legacyVersion: s.legacyVersion,
      agentIds: s.agentIds,
      effortLevel: s.effortLevel,
      disableAutoMemory: s.disableAutoMemory,
      enableCodexReview: s.enableCodexReview ? true : undefined,
    } : undefined,
    codexOptions: s.codexOptions,
  }))
  return {
    sessions,
    activeSessionId: state.activeSessionId,
    savedAt: Date.now(),
  }
}

/**
 * Persist a session's chosen account (profileId) to disk IMMEDIATELY.
 *
 * The pre-spawn account gate and the mid-session switch both pin profileId in
 * the in-memory store, but session-state.json was previously only written on a
 * graceful close. A CRASH therefore dropped the per-session account, so the next
 * launch re-defaulted the gate to the primary profile instead of the account the
 * user last used for that session (the exact symptom seen after the OOM crash).
 * Flushing eagerly here makes the choice crash-durable: on restore the gate
 * pre-selects the persisted session.profileId. updateSession runs synchronously
 * BEFORE the await, so callers that immediately read the store / respawn still
 * see the new id; the disk flush is best-effort and never blocks the spawn.
 */
export async function persistLastUsedAccount(sessionId: string, profileId: string | undefined): Promise<void> {
  useSessionStore.getState().updateSession(sessionId, { profileId })
  try {
    await window.electronAPI.session.save(buildSessionState())
  } catch {
    /* best-effort: the choice still lives in the store for this run */
  }
}
