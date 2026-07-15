// src/renderer/hooks/useAccountIdentitySubscription.ts
import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import type { IdentityColorKey } from '../../shared/identity-colors'

/**
 * Surface the RELIABLE per-session account identity captured at spawn in main
 * (claude-account-identity.ts). On mount the hook both PULLs once (covers the
 * case where capture finished before the hook mounted) and SUBSCRIBEs to the
 * spawn-time push (covers the reverse). Both write the same session fields
 * (accountEmail / accountColour) so they are idempotent. Mirrors
 * useEffortSubscription. Repopulates the v1.5.9-inert Session.accountEmail /
 * accountColour fields from the drift-immune source.
 */
export function useAccountIdentitySubscription(sessionId: string) {
  const updateSession = useSessionStore((s) => s.updateSession)
  useEffect(() => {
    let cancelled = false
    // (a) PULL once -- capture may have completed before this hook mounted.
    void window.electronAPI.accountIdentity.get(sessionId).then((id) => {
      if (cancelled || !id) return
      updateSession(sessionId, { accountEmail: id.email, accountColour: id.colourKey as IdentityColorKey })
    })
    // (b) SUBSCRIBE -- capture may complete after this hook mounted.
    const unsub = window.electronAPI.accountIdentity.onUpdate(({ sessionId: sid, email, colourKey }) => {
      if (sid !== sessionId) return
      updateSession(sessionId, { accountEmail: email, accountColour: colourKey as IdentityColorKey })
    })
    return () => { cancelled = true; unsub() }
  }, [sessionId, updateSession])
}
