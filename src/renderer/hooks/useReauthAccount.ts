import { useCallback } from 'react'
import { generateId } from '../utils/id'
import { useSessionStore } from '../stores/sessionStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import type { AccountProfile } from '../../shared/account-types'

// Re-auth of an EXISTING account (its stored token expired). Same mechanism as
// useAddAccount — open a shell-only login session pinned to the profile and
// poll until /login rewrites the account's credentials — but targets the
// existing profileId instead of creating a new one. A full fresh login writes a
// complete credential set into that account's isolated home, so it sidesteps
// the rotating-refresh-token hazard of a silent refresh entirely.
const POLL_MS = 4000
const MAX_ATTEMPTS = 300 // ~20 min backstop; the session-gone check is the real bound

function pollForReauth(profileId: string, sessionId: string, onDone: () => void): void {
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
        try { onDone() } catch { /* callback must not break the poll teardown */ }
        return
      }
    } catch { /* transient; keep polling */ }
    if (attempts >= MAX_ATTEMPTS) clearInterval(timer)
  }, POLL_MS)
}

/** Open a login shell for an EXISTING account so the user can re-authenticate
 *  it, then run `onDone` (e.g. re-fetch usage) once the login lands. Returns the
 *  new login session id; the caller should switch to the sessions view. */
export function useReauthAccount(): (profile: Pick<AccountProfile, 'id' | 'name'>, onDone?: () => void) => string {
  const addSession = useSessionStore((s) => s.addSession)
  return useCallback((profile, onDone) => {
    const sessionId = generateId()
    addSession({
      id: sessionId,
      label: profile.name,
      workingDirectory: '',
      model: '',
      color: '#89B4FA',
      status: 'idle',
      createdAt: Date.now(),
      sessionType: 'local',
      shellOnly: true,
      provider: 'claude',
      profileId: profile.id,
      needsLogin: true,
    })
    pollForReauth(profile.id, sessionId, onDone ?? (() => {}))
    return sessionId
  }, [addSession])
}
