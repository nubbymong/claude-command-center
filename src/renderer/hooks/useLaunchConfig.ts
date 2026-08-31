import { useCallback } from 'react'
import { Session, useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { TerminalConfig } from '../stores/configStore'
import { generateId } from '../utils/id'
import { markSessionForResumePicker } from '../utils/resumePicker'
import { useDetachedRemotesStore } from '../stores/detachedRemotesStore'
import { useResumeLaunchStore } from '../stores/resumeLaunchStore'
import { resumableRemotesForConfig } from '../utils/detachedRemotes'
import { refreshDetachedLiveness } from '../stores/livenessStore'

/** True when this config cannot launch because the Codex master is off.
 *  Single source of truth for every launch surface (rows, pinned panel,
 *  empty-state cards) AND the launch action itself. */
export function isConfigLaunchBlocked(config: Pick<TerminalConfig, 'provider'>): boolean {
  return config.provider === 'codex' && useSettingsStore.getState().settings.codexEnabled === false
}

/** The reason shown wherever a blocked config is marked disabled. */
export const CODEX_OFF_LAUNCH_REASON = 'Codex is off. Enable it in Settings → Codex to launch this config.'

/** Overrides for a launch. SSH Persistent (Phase 3): a resume reuses the
 *  detached remote's ORIGINAL session id and asks for the SSH reconnect flag so
 *  the tmux target `ccc-<sessionId>` matches and, on a lost remote, `--continue`
 *  resumes the conversation. */
export interface LaunchSessionOptions {
  /** Reuse this id instead of minting a fresh one (reattach). Safe ONLY because
   *  the old tile was removed on Leave running — never pass a live id. */
  sessionId?: string
  /** Force SSHOptions.reconnect for this spawn (via sshReachedClaudeRunning, the
   *  field TerminalView reads to compute reconnect). */
  reconnect?: boolean
}

/**
 * Build the Session object for a config launch, or `null` when the config is
 * launch-blocked (Codex off). Pure aside from `isConfigLaunchBlocked` (reads
 * settings) and id generation — extracted so both the sidebar/empty-state launch
 * and the resume dialog build the SAME session shape. Credentials are resolved in
 * main at PTY spawn time, never here.
 */
export function buildLaunchSession(config: TerminalConfig, opts?: LaunchSessionOptions): Session | null {
  // Backstop for any path that missed the disabled UI (group/section
  // launch-all included): a Codex config never spawns while Codex is off.
  if (isConfigLaunchBlocked(config)) return null
  const session: Session = {
    id: opts?.sessionId ?? generateId(),
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
  // SSH Persistent (Phase 3): a reattach spawns with reconnect set. TerminalView
  // computes SSHOptions.reconnect from sshReachedClaudeRunning, so pre-latching it
  // here makes the resumed spawn a reconnect — attach reattaches the live claude,
  // and if the remote session is gone the fresh-create branch adds `--continue`.
  if (opts?.reconnect) session.sshReachedClaudeRunning = true
  return session
}

/**
 * The raw launch action: build the session, mark a fresh local session for the
 * resume picker, and add it. Returns the new session id (or '' when blocked).
 * Used by both `useLaunchConfig` (after the resume gate) and the resume dialog.
 */
export function useLaunchSessionAction(): (config: TerminalConfig, opts?: LaunchSessionOptions) => string {
  const addSession = useSessionStore((s) => s.addSession)
  return useCallback((config: TerminalConfig, opts?: LaunchSessionOptions) => {
    const session = buildLaunchSession(config, opts)
    if (!session) return ''
    // Resume-picker only for a FRESH local Claude session — never a reattach
    // (which reuses an id and is SSH, so this is inert there anyway).
    if (!opts?.sessionId && !session.shellOnly && session.sessionType === 'local') {
      markSessionForResumePicker(session.id)
    }
    addSession(session)
    return session.id
  }, [addSession])
}

/**
 * Shared "launch a saved config into a new active session" action. Reused by the
 * centre empty state and the sidebar so every surface takes the EXACT same path.
 * Returns the new session id, or '' when the launch is blocked OR deferred to the
 * resume prompt (Phase 2).
 *
 * SSH Persistent — "Resume a Running Session": before launching an SSH config,
 * consult the detached-remote registry. If one or more left-running remotes match
 * this config and are not already live, park the launch in the resume store and
 * open ResumeSessionDialog instead of spawning; the dialog then reattaches
 * (Resume), launches fresh, or cancels. Non-SSH launches and SSH configs with no
 * match are unaffected.
 */
export function useLaunchConfig(): (config: TerminalConfig) => string {
  const launch = useLaunchSessionAction()
  return useCallback((config: TerminalConfig) => {
    if (isConfigLaunchBlocked(config)) return ''
    const entries = useDetachedRemotesStore.getState().entries
    if (entries.length > 0) {
      // Only reached with a non-empty registry, so tests with no detached
      // remotes never touch the session store's getState here.
      const liveIds = useSessionStore.getState().sessions.map((s) => s.id)
      const matches = resumableRemotesForConfig(entries, config, liveIds)
      if (matches.length > 0) {
        // Open the prompt immediately (optimistic) AND kick off the host liveness
        // probe: the dialog reconciles as it returns — hiding confirmed-dead rows,
        // marking unreachable ones "couldn't verify", pruning dead from the
        // registry. Opening first (rather than blocking up to the probe timeout)
        // keeps the launch responsive; a reattach self-heals if a shown remote
        // turns out gone.
        useResumeLaunchStore.getState().request({ config, entries: matches })
        void refreshDetachedLiveness(config)
        return ''
      }
    }
    return launch(config)
  }, [launch])
}
