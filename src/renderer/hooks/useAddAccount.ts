import { useCallback } from 'react'
import { generateId } from '../utils/id'
import { useSessionStore } from '../stores/sessionStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import type { AccountProfile } from '../../shared/account-types'

// The poll keeps checking while the login session is open (the user may take
// minutes completing the browser OAuth flow). It stops on detection, when the
// session is closed (the real bound), or after the 20-min backstop.
const POLL_MS = 4000
const MAX_ATTEMPTS = 300 // ~20 min backstop; the session-gone check is the real bound

function pollForIdentity(profileId: string, sessionId: string): void {
  let attempts = 0
  const timer = setInterval(async () => {
    attempts++
    const exists = useSessionStore.getState().sessions.some((s) => s.id === sessionId)
    if (!exists) { clearInterval(timer); return } // session closed -> stop
    try {
      const res = await window.electronAPI.accountProfiles.refreshIdentity(profileId)
      if (res && res.email) {
        clearInterval(timer)
        await useAccountProfilesStore.getState().hydrate()
        useSessionStore.getState().updateSession(sessionId, { needsLogin: false, label: res.email })
        return
      }
    } catch { /* transient; keep polling */ }
    if (attempts >= MAX_ATTEMPTS) clearInterval(timer)
  }, POLL_MS)
}

/** Create an empty profile, open a shell-only login session under it, and poll
 *  until the user's /login writes the account. Returns the new profile + session id.
 *  Callers should switch to the sessions view so the user sees the login shell.
 *
 *  NOTE: pollForIdentity is intentionally decoupled from any component lifetime.
 *  The flow starts from Settings/the gate, but the user then navigates to the
 *  sessions view to run /login -- so a useEffect cleanup tied to the trigger
 *  component would cancel the poll exactly when it must keep running. The poll
 *  is self-bounding: it stops on success, when the session is closed (the real
 *  bound), or after the 20-min backstop (MAX_ATTEMPTS). */
export function useAddAccount(): (name?: string) => Promise<{ profile: AccountProfile; sessionId: string }> {
  const addSession = useSessionStore((s) => s.addSession)
  return useCallback(async (name?: string) => {
    const profile = await useAccountProfilesStore.getState().create(name)
    const sessionId = generateId()
    addSession({
      id: sessionId,
      label: profile.name,
      workingDirectory: '',
      model: '',
      // #89B4FA = Catppuccin Mocha blue; the standard safe-default session colour
      // for programmatically-created sessions that have no config-picker colour.
      color: '#89B4FA',
      status: 'idle',
      createdAt: Date.now(),
      sessionType: 'local',
      shellOnly: true,
      provider: 'claude',
      profileId: profile.id,
      needsLogin: true,
    })
    pollForIdentity(profile.id, sessionId)
    return { profile, sessionId }
  }, [addSession])
}
