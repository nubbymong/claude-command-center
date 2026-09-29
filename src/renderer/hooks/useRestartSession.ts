import { useCallback } from 'react'
import { Session, useSessionStore } from '../stores/sessionStore'
import { killSessionPty, clearSpawned } from '../ptyTracker'
import { markSessionForResumePicker } from '../utils/resumePicker'
import { restartPicksConversation } from '../utils/launchAccount'
import { useAccountGateStore } from '../stores/accountGateStore'
import { spentCommand } from '../utils/commandTerminal'
import { restartLaunchRefusal } from './useLaunchConfig'
import { useConfigStore } from '../stores/configStore'
import { reportSpawnEnd } from '../utils/spawnEndNotice'

// Shared restart/recover logic for SessionHeader and the v2 bottom bar.
// Behaviour is identical to the inline functions that previously lived in
// SessionHeader -- extracted so both can share the EXACT same mechanism.

/** How a restart starts the session again. */
export interface RestartOptions {
  /** Open the resume picker so the user picks the conversation (canvas F7,
   *  "Restart and pick a conversation"). Absent, the provider's default
   *  applies (restartPicksConversation): some providers always offer it,
   *  others offer a plain "Restart" that carries on with the conversation
   *  the tab is on (main resumes it; P3.5). */
  pickConversation?: boolean
}

/** A tab whose launch started nothing is not its config's running copy, so
 *  restarting it launches the config, and it passes the Multi Spawn rule like
 *  any launch (restartLaunchRefusal). Refused: nothing is killed or remounted,
 *  the tab stays Not started, and the view showing it says why
 *  (utils/spawnEndNotice). True when refused. */
function refuseRestart(sessionId: string): boolean {
  const live = useSessionStore.getState().getSession(sessionId)
  const refusal = live ? restartLaunchRefusal(live, useConfigStore.getState().configs) : undefined
  if (refusal === undefined) return false
  reportSpawnEnd(sessionId, `\r\n\x1b[90mNot started: ${refusal}\x1b[0m`)
  return true
}

export function useRestartSession(
  session: Session | null | undefined,
  isShowingPartner = false,
): { restart: (overrides?: Partial<Session>, options?: RestartOptions) => boolean; recover: () => void } {
  const forceRemount = useCallback(
    (status: 'idle' | 'working', overrides?: Partial<Session>) => {
      if (!session) return
      const store = useSessionStore.getState()
      // Merge from the LIVE store record (not just the captured closure) so a
      // store mutation made immediately before restart -- e.g. switchAccount
      // setting profileId -- survives the remove/re-add. `overrides` lets the
      // caller force specific fields (profileId) even if the store read raced.
      const live = store.getSession(session.id)
      const merged = { ...session, ...live, ...overrides }
      store.removeSession(session.id)
      store.addSession({
        ...merged,
        id: session.id,
        // A transient tab's command ran once and is not run again by a
        // Restart. TerminalView consumes it at spawn; this is the second
        // fence, for a captured record that still carries it.
        ...(merged.transient ? { terminalOptions: spentCommand(merged.terminalOptions) } : {}),
        status,
        createdAt: Date.now(),
        // Clear stale metadata from previous run
        contextPercent: undefined,
        costUsd: undefined,
        needsAttention: false,
        modelName: undefined,
        // Graceful-fail: the previous run's live indicators must not linger on the
        // restarted card. Clearing effortLive re-hides the effort pill (and fastMode
        // the bolt) until the new run's first statusline tick confirms them.
        effortLive: undefined,
        fastMode: undefined,
        // The whole point of a remount is that a new PTY is about to exist.
        // Leaving the previous run's exit flag set would make every liveness
        // check (findAskSession's, the dock's dot) read the fresh session as
        // dead.
        ptyExited: undefined,
        // Nor does the last launch's "started nothing": this one may start.
        neverStarted: undefined,
        // #85: the wheel->tmux-scrollback translation is armed off this flag,
        // and a restart re-runs SSH connect, auth and remote setup before
        // anything decides whether tmux is in play this time. Left set, the
        // wheel would be writing tmux keys into a login shell or a password
        // prompt. Main re-pushes it when the new launch is actually wrapped.
        sshTmuxPersistent: undefined,
        // A restart re-runs the spawn effect. Ask Conductor's opening question
        // is one-shot: without this, restarting an Ask session would re-submit
        // whatever the user first typed. TerminalView also consumes it at spawn;
        // this is the second fence, because forceRemount merges the CAPTURED
        // session on top of nothing when the store read races.
        askPrompt: undefined,
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
        // Per-model usage buckets (statusline limits[], incl. the weekly Fable
        // bucket) are live indicators too -- omitting them left the previous
        // account's hit limit painted on the card after a mid-session switch
        // (which routes through this same remount) until a later tick overwrote
        // it. Clear them like the rateLimit* siblings.
        usageBuckets: undefined,
        usageUnavailable: undefined,
        // #266 MAJOR-4: the watchdog badge (waiting/gave-up) belongs to the
        // PREVIOUS run's watcher, which the restart tears down; main pushes a
        // fresh 'monitoring' state when the new run arms one.
        watchdog: undefined,
      })
    },
    [session],
  )

  /** True when the session was restarted; false when there was none, or
   *  the restart was refused (refuseRestart). */
  const restart = useCallback((overrides?: Partial<Session>, options?: RestartOptions): boolean => {
    if (!session) return false
    if (isShowingPartner) {
      // The remount below re-keys the main view too. A main tab whose launch
      // started nothing keeps that flag through it, and the remounted view
      // checks the Multi Spawn rule before it starts it (TerminalView), so the
      // partner always restarts and the main tab never becomes a second copy.
      // Partner terminal: just kill partner PTY, leave main Claude untouched
      const partnerPtyId = session.id + '-partner'
      // Only kill the partner -- don't use killSessionPty which also kills main+partner
      window.electronAPI.pty.kill(partnerPtyId)
      // Clear partner from spawn tracker so it respawns on remount
      clearSpawned(partnerPtyId)
      // Force re-mount by bumping createdAt. Merge the live store record +
      // overrides so a pre-restart store mutation (e.g. profileId) survives.
      const store = useSessionStore.getState()
      const live = store.getSession(session.id)
      store.removeSession(session.id)
      store.addSession({ ...session, ...live, ...overrides, id: session.id, status: session.status, createdAt: Date.now() })
      return true
    }
    if (refuseRestart(session.id)) return false
    // Kill the old PTY (also clears spawn tracker so new one will spawn)
    killSessionPty(session.id)
    // Mark the resume picker, unless this provider's plain "Restart" does not
    // open it (canvas F7). Either way main resumes the conversation the
    // session is on when it knows it -- over a picker a plain Restart marked,
    // never over an explicit "Restart and pick a conversation" (P3.5); with
    // none known, a Restart that marked the picker shows it, and a plain
    // Restart that did not starts a new conversation.
    const pick = options?.pickConversation ?? restartPicksConversation(session.provider)
    if (session.sessionType === 'local' && !session.shellOnly && pick) {
      markSessionForResumePicker(session.id)
    }
    // Restart (and switch, which routes through here) already determines the
    // account -- the re-spawn must NOT pop the pre-spawn account gate.
    useAccountGateStore.getState().markPredetermined(session.id)
    // Force re-mount with clean metadata
    forceRemount('idle', overrides)
    return true
  }, [session, isShowingPartner, forceRemount])

  const recover = useCallback(() => {
    if (!session) return
    if (refuseRestart(session.id)) return
    const partnerPtyId = session.id + '-partner'
    // Kill both main and partner PTYs (ignore errors -- process may already be dead)
    window.electronAPI.pty.kill(session.id)
    window.electronAPI.pty.kill(partnerPtyId)
    clearSpawned(session.id)
    clearSpawned(partnerPtyId)
    // Show resume picker for Claude sessions
    if (session.sessionType === 'local' && !session.shellOnly) {
      markSessionForResumePicker(session.id)
    }
    // Recover preserves the current account -- skip the pre-spawn gate.
    useAccountGateStore.getState().markPredetermined(session.id)
    forceRemount('idle')
  }, [session, forceRemount])

  return { restart, recover }
}
