import { useCallback } from 'react'
import { Session, useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { TerminalConfig } from '../stores/configStore'
import { generateId } from '../utils/id'
import { markSessionForResumePicker } from '../utils/resumePicker'

/** True when this config cannot launch because the Codex master is off.
 *  Single source of truth for every launch surface (rows, pinned panel,
 *  empty-state cards) AND the launch action itself. */
export function isConfigLaunchBlocked(config: Pick<TerminalConfig, 'provider'>): boolean {
  return config.provider === 'codex' && useSettingsStore.getState().settings.codexEnabled === false
}

/** The reason shown wherever a blocked config is marked disabled. */
export const CODEX_OFF_LAUNCH_REASON = 'Codex is off. Enable it in Settings → Codex to launch this config.'

/**
 * Shared "launch a saved config into a new active session" action. Extracted
 * verbatim from Sidebar.launchFromConfig so the centre empty state reuses the
 * EXACT same launch path (no behaviour drift). Returns the new session id.
 * Credentials are resolved in the main process at PTY spawn time, never here.
 * addSession() sets the new session active (sessionStore), so callers only need
 * to ensure the 'sessions' view is shown.
 */
export function useLaunchConfig(): (config: TerminalConfig) => string {
  const addSession = useSessionStore((s) => s.addSession)
  return useCallback((config: TerminalConfig) => {
    // Backstop for any path that missed the disabled UI (group/section
    // launch-all included): a Codex config never spawns while Codex is off.
    if (isConfigLaunchBlocked(config)) return ''
    const session: Session = {
      id: generateId(),
      configId: config.id,
      label: config.label,
      workingDirectory: config.workingDirectory,
      model: config.claudeOptions?.model ?? '',
      color: config.color,
      status: 'idle',
      createdAt: Date.now(),
      sessionType: config.sessionType,
      shellOnly: config.shellOnly,
      terminalOptions: config.terminalOptions,
      // Partner terminal is permanent for every config type (2 Aug decision):
      // stored partnerTerminalPath/partnerElevated are no longer consumed.
      sshConfig: config.sshConfig ? {
        host: config.sshConfig.host,
        port: config.sshConfig.port,
        username: config.sshConfig.username,
        remotePath: config.sshConfig.remotePath,
        hasPassword: config.sshConfig.hasPassword,
        postCommand: config.sshConfig.postCommand,
        hasSudoPassword: config.sshConfig.hasSudoPassword,
        dockerContainer: config.sshConfig.dockerContainer,
        runtime: config.sshConfig.runtime,
        // SSH tmux enhancement (items 1/3): these MUST ride through to the
        // launched session or the spawn never sees them. Dropping `detachable`
        // here left the owner's "never silently install tmux" opt-out inert
        // (main defaulted persistence ON) and made remoteOs:'windows'
        // unreachable -- same field-by-field-rebuild drop the comment below
        // records for the indexing opt-out (adversarial review, 2026-08-18).
        detachable: config.sshConfig.detachable,
        remoteOs: config.sshConfig.remoteOs,
      } : undefined,
      legacyVersion: config.claudeOptions?.legacyVersion,
      agentIds: config.claudeOptions?.agentIds,
      machineName: config.machineName,
      effortLevel: config.claudeOptions?.effortLevel,
      permissionMode: config.claudeOptions?.permissionMode,
      extraArgs: config.claudeOptions?.extraArgs,
      disableAutoMemory: config.claudeOptions?.disableAutoMemory,
      // Launch must carry the indexing opt-out or the spawn never sees it
      // (pre-2.1.0-beta.5 bug: this path dropped it, so the toggle was inert
      // for sidebar launches). enableCodexReview is retired — the tool is
      // authorised globally now, not per config.
      loggingEnabled: config.claudeOptions?.loggingEnabled,
      provider: config.provider,
      profileId: config.profileId,
      codexOptions: config.codexOptions,
      githubIntegration: config.githubIntegration,
    }
    if (!session.shellOnly && session.sessionType === 'local') {
      markSessionForResumePicker(session.id)
    }
    addSession(session)
    return session.id
  }, [addSession])
}
