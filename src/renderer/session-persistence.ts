import { useSessionStore } from './stores/sessionStore'
import { useAccountGateStore } from './stores/accountGateStore'
import { useSettingsStore } from './stores/settingsStore'
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
    customName: s.customName,
    workingDirectory: s.workingDirectory,
    color: s.color,
    identityColorKey: s.identityColorKey,
    legacyColor: s.legacyColor,
    sessionType: s.sessionType,
    shellOnly: s.shellOnly,
    terminalOptions: s.terminalOptions,
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
    // T8b (bug #5): persist the exact conversation so app-relaunch resumes it.
    // Sync pass-through of whatever is on the store record; enrichWithResumeTargets
    // (the async caller) refreshes these from the live binder before save.
    resumeUuid: s.resumeUuid,
    resumeCwd: s.resumeCwd,
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
 * T8b (bug #5): build the persisted session state AND enrich each live Claude
 * session with its exact-conversation resume target (resumeUuid/resumeCwd) so an
 * app-relaunch resumes the SAME conversation, not the newest in the cwd's folder.
 *
 * buildSessionState() is sync (used by several call sites); this async wrapper is
 * the choke point for the save-and-quit / autosave paths where we can afford one
 * IPC round-trip per session. Fully fail-safe: any session whose target can't be
 * resolved keeps whatever was already on the record (typically undefined), so the
 * fallback is exactly today's behaviour. Non-Claude / shell-only sessions are
 * skipped (the binder only tracks Claude transcripts).
 */
export async function buildSessionStateWithResumeTargets(): Promise<SessionState> {
  const state = buildSessionState()
  const api = window.electronAPI?.logsdb
  if (!api?.getResumeTarget) return state
  await Promise.all(
    state.sessions.map(async (saved) => {
      if (saved.shellOnly) return
      if ((saved.provider ?? 'claude') !== 'claude') return
      try {
        const target = await api.getResumeTarget(saved.id)
        if (target && target.uuid && target.cwd) {
          saved.resumeUuid = target.uuid
          saved.resumeCwd = target.cwd
        }
      } catch {
        // best-effort: leave whatever was already on the record
      }
    }),
  )
  return state
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
/**
 * Mark every relaunch-restored session as predetermined in the account gate so
 * its respawn continues under the SAME account it was closed on, skipping the
 * pre-spawn AccountLaunchGate re-prompt (issue #76).
 *
 * The relaunch account is already determined -- it is the persisted
 * session.profileId -- exactly like an in-session Restart/Recover/Switch, all of
 * which call markPredetermined for the same reason. Without this, every restored
 * multi-account (>=2 profiles) session re-pops the picker on each launch and does
 * not auto-continue under its account; a relaunched session could even come back
 * on a different account than it left.
 *
 * Must be called BEFORE the store restore that mounts the TerminalViews, so the
 * flag is set before each spawn effect reads consumePredetermined(). The flag is
 * consumed only on the gate-eligible path, so it is a harmless no-op for
 * single-account / shell-only / Codex / SSH restores.
 */
export function markRestoredSessionsPredetermined(sessionIds: string[]): void {
  const gate = useAccountGateStore.getState()
  for (const id of sessionIds) gate.markPredetermined(id)
}

export async function persistLastUsedAccount(sessionId: string, profileId: string | undefined): Promise<void> {
  useSessionStore.getState().updateSession(sessionId, { profileId })
  // Record it as the GLOBAL last-used account so the launch gate can offer it as
  // a one-click default for the next new session. Only a real choice updates it
  // (never clear it back to undefined). Best-effort persist.
  if (profileId) {
    // updateSettings returns a Promise: attach .catch (a bare try/catch would
    // not see an async rejection and it would surface as unhandled).
    try {
      void useSettingsStore.getState().updateSettings({ lastUsedAccountId: profileId }).catch(() => { /* non-fatal */ })
    } catch { /* non-fatal (synchronous set() failure) */ }
  }
  try {
    await window.electronAPI.session.save(buildSessionState())
  } catch {
    /* best-effort: the choice still lives in the store for this run */
  }
}
