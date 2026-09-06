import { useSessionStore } from './stores/sessionStore'
import { useAccountGateStore } from './stores/accountGateStore'
import { useSettingsStore } from './stores/settingsStore'
import { useDetachedRemotesStore } from './stores/detachedRemotesStore'
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
    kind: s.kind,
    // `askPrompt` is deliberately absent. This map is an ALLOWLIST, and that
    // omission is the whole mechanism keeping an Ask Conductor question off
    // disk: adding it here would write the user's typed question into
    // session-state.json AND re-submit it on the next launch.
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
          runtime: s.sshConfig.runtime,
          detachable: s.sshConfig.detachable,
          remoteOs: s.sshConfig.remoteOs,
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
      // #397 Group 4: round-trip these so a restored session keeps its permission
      // mode and extra CLI args (previously dropped on save, so relaunch lost them).
      permissionMode: s.permissionMode,
      extraArgs: s.extraArgs,
      // rc.14 review F14: the per-session indexing opt-out. Restore reads it
      // from here and the run-registration gate treats a missing value as
      // enabled, so dropping it on save indexed a session the user excluded.
      loggingEnabled: s.loggingEnabled,
    } : undefined,
    codexOptions: s.codexOptions,
  }))
  return {
    sessions,
    activeSessionId: state.activeSessionId,
    savedAt: Date.now(),
    // SSH Persistent (Phase 1): fold the left-running registry into the same
    // persisted file so a detached remote survives an app restart. Main round-
    // trips this untouched (only `sessions` is migrated on load).
    detachedRemotes: useDetachedRemotesStore.getState().entries,
  }
}

/**
 * Best-effort flush of the current session state to disk NOW, without waiting for
 * the ~1s debounced autosave. Used by the SSH Persistent paths (Leave running /
 * End remote / Resume) so a registry change is durable immediately even if the
 * app closes in the debounce window. Never throws — the choice still lives in the
 * store for this run if the write fails (preload absent, main refused, etc.).
 */
export async function persistSessionState(): Promise<void> {
  try {
    await window.electronAPI?.session?.save(buildSessionState())
  } catch {
    /* best-effort: the debounced autosave rewrites on the next session-set change */
  }
}

/**
 * rc.14 review F9 (aicc_planning#53): the left-running registry must outlive the
 * attached session set. Three exits used to `session.clear()` the whole file --
 * the zero-tab close, "Don't open" on the resume prompt, "Don't save" on the
 * close dialog -- and took the Remote Resumable entries with it, although the
 * remote work they point at is still running; the next launch of that config
 * then started NEW work instead of reattaching. With a non-empty registry this
 * writes a state with NO sessions and the registry; with an empty one it clears
 * as before. Either way the discarded sessions cannot come back: the saved set
 * is empty, so the exit-time flush re-asserts nothing.
 */
export async function persistDetachedOnlyOrClear(): Promise<'saved' | 'cleared'> {
  const detachedRemotes = useDetachedRemotesStore.getState().entries
  if (detachedRemotes.length === 0) {
    await window.electronAPI?.session?.clear()
    return 'cleared'
  }
  await window.electronAPI?.session?.save({ sessions: [], activeSessionId: null, savedAt: Date.now(), detachedRemotes })
  return 'saved'
}

/**
 * Hydrate the left-running registry from a saved state on its own, for the boot
 * paths that restore NO attached sessions (nothing saved, or the user declined
 * the resume prompt). Returns how many entries the store holds afterwards, so
 * the caller can start the reachability pass only when there is something to
 * ping. Same sanitising hydrate the restore path uses.
 */
export function hydrateDetachedFromSavedState(saved: Pick<SessionState, 'detachedRemotes'> | null | undefined): number {
  const entries = saved?.detachedRemotes
  if (!Array.isArray(entries) || entries.length === 0) return 0
  useDetachedRemotesStore.getState().hydrate(entries)
  return useDetachedRemotesStore.getState().entries.length
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
 *
 * #446: the caller (App restore) now runs this CONDITIONALLY —
 * `shouldPredetermineRestoredAccount(settings.resumeAccountMode)`. It is the
 * default ('auto-last'); under 'ask' the caller skips it so the gate opens per
 * restored session. This function itself is unchanged: it always marks what it
 * is given.
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
