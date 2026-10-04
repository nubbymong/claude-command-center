// WP2 PR 4 (owner answers, 2026-10-04): the Claude adapter's sign-in status
// and sign-out, by reuse. The package runs no CLI of its own here: the
// composition root hands it the app's existing Claude implementations (the
// `claude auth status` probe the Accounts panel uses, and the sign-out beside
// it, both in src/main/account-web/claude-cli-auth.ts), and this module turns
// a registry realm into the one profile it names and the result into the
// provider contract. A Claude account's realm is its profile home
// (`claude-profile:<id>`), so a status or a sign-out reaches that profile's
// home and no other.
//
// Sign-in is not offered here: a Claude account signs in with the CLI's own
// login in a Conductor terminal (the Accounts panel), and `auth.browser`
// stays undeclared until that is wired.
import type { ProviderAuthOperations, RealmRef, AuthOperationResult, AuthFailureCode, AuthStatusOptions } from '../core'
import type { AuthRealm, KnownAuthState } from '../../../shared/providers'
import { claudeProfileOfRealm } from './review-launch'

/** A profile's sign-in as the app's probe reads it (ClaudeCliAuthStatus). */
export interface ClaudeProfileAuthStatus {
  authenticated: boolean
  /** Set when nothing could be determined. */
  error?: string
}

/** What the app's sign-out reports (ClaudeCliLogoutResult). */
export interface ClaudeProfileLogout {
  ran: boolean
  after: ClaudeProfileAuthStatus | null
  refused?: 'invalid-profile' | 'in-use' | 'no-home' | 'host-control'
  timedOut?: boolean
}

/** What the composition root hands the package for sign-in status and
 *  sign-out. */
export interface ClaudeAuthPorts {
  /** The registry's record of a live realm (a snapshot read, never the lock). */
  lookupRealm(ref: RealmRef): Promise<{ ok: true; realm: AuthRealm } | { ok: false }>
  /** One profile's `claude auth status`, as the Accounts panel reads it. */
  readStatus(profileId: string): Promise<ClaudeProfileAuthStatus>
  /** One profile's `claude auth logout`, then its state read afresh. */
  logout(profileId: string): Promise<ClaudeProfileLogout>
  platform?: NodeJS.Platform
}

/** macOS: Claude Code keeps one sign-in there, in the login keychain found
 *  through $HOME and shared by every Claude Code on the Mac (D2; withProfileHome,
 *  #117). A profile home cannot reach it, and signing that sign-in out would
 *  reach every app using it, so the sign-out is not offered. */
export const CLAUDE_MAC_SIGN_OUT_REFUSAL = 'On macOS Claude Code keeps one sign-in for every app on this Mac. Sign out with Claude Code itself.'

type Status = { state: KnownAuthState } & AuthOperationResult
const refuse = (code: AuthFailureCode, message?: string): AuthOperationResult => ({ ok: false, code, ...(message ? { message } : {}) })
const unread = (code: AuthFailureCode): Status => ({ ok: false, code, state: 'error' })

export function createClaudeAuthOperations(ports: ClaudeAuthPorts): ProviderAuthOperations {
  const platform = ports.platform ?? process.platform

  /** The profile a realm names: a live Claude profile-home realm whose
   *  reference names a valid profile id, looked up by exactly this id;
   *  anything else (a throw included) is null. */
  const profileOf = async (ref: RealmRef): Promise<string | null> => {
    try {
      const id = ref && typeof ref === 'object' ? (ref as { authRealmId?: unknown }).authRealmId : undefined
      if (typeof id !== 'string' || !id) return null
      const found = await ports.lookupRealm({ authRealmId: id })
      if (!found || found.ok !== true || !found.realm || found.realm.id !== id) return null
      return claudeProfileOfRealm(found.realm)
    } catch {
      return null
    }
  }

  /** The probe's answer as a sign-in state, or why there is none. */
  const stateOf = (s: ClaudeProfileAuthStatus | null | undefined): Status => {
    if (!s || typeof s !== 'object' || typeof s.error === 'string') return unread('status-unrecognised')
    if (s.authenticated === true) return { ok: true, state: 'signed-in' }
    if (s.authenticated === false) return { ok: true, state: 'signed-out' }
    return unread('status-unrecognised')
  }

  return {
    async status(realm: RealmRef, opts?: AuthStatusOptions): Promise<Status> {
      if (opts?.signal?.aborted) return unread('cancelled')
      const profileId = await profileOf(realm)
      if (!profileId) return unread('realm-unavailable')
      let read: ClaudeProfileAuthStatus
      try {
        read = await ports.readStatus(profileId)
      } catch {
        return unread('not-started')
      }
      // A check no longer wanted answers no state (AuthStatusOptions).
      if (opts?.signal?.aborted) return unread('cancelled')
      return stateOf(read)
    },

    async logout(realm: RealmRef): Promise<AuthOperationResult> {
      if (platform === 'darwin') return refuse('method-unsupported', CLAUDE_MAC_SIGN_OUT_REFUSAL)
      const profileId = await profileOf(realm)
      if (!profileId) return refuse('realm-unavailable')
      let out: ClaudeProfileLogout
      try {
        out = await ports.logout(profileId)
      } catch {
        return refuse('not-started')
      }
      if (!out || typeof out !== 'object') return refuse('not-started')
      if (out.refused === 'in-use') return refuse('busy', 'Something is using this Claude account (a session, or a check of it). Close it, then sign out.')
      if (out.refused === 'invalid-profile' || out.refused === 'no-home') return refuse('realm-unavailable')
      if (out.refused !== undefined || out.ran !== true) return refuse('not-started')
      if (out.timedOut === true) return { ...refuse('timed-out'), ran: true }
      // The verdict is the profile's state afterwards, not the sign-out's exit.
      const after = stateOf(out.after)
      if (after.ok && after.state === 'signed-out') return { ok: true, state: 'signed-out' }
      if (after.ok && after.state === 'signed-in') return { ...refuse('still-signed-in'), state: 'signed-in', ran: true }
      return { ...refuse('status-unrecognised'), ran: true }
    },

    async login(): Promise<AuthOperationResult> {
      return refuse('method-unsupported')
    },
  }
}
