import { useCallback } from 'react'
import { generateId } from '../utils/id'
import { useSessionStore } from '../stores/sessionStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import type { AccountProfile } from '../../shared/account-types'

const POLL_MS = 4000
const MAX_ATTEMPTS = 30 // ~2 min

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
 *  Callers should switch to the sessions view so the user sees the login shell. */
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
