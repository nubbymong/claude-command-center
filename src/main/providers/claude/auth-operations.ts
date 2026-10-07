// WP2 PR 4 (owner answers, 2026-10-04): the Claude adapter's sign-in status
// and sign-out, by reuse. The package starts no CLI of its own here: the
// composition root hands it the app's existing Claude implementations (the
// `claude auth status` probe the Accounts panel uses, and the sign-out beside
// it, both in src/main/account-web/claude-cli-auth.ts), and this module turns
// a registry realm into the one profile it names, hands over the executable
// discovery last proved, and turns the result into the provider contract. A
// Claude account's realm is its profile home (`claude-profile:<id>`), so a
// status or a sign-out reaches that profile's home and no other.
//
// Sign-in is not offered here: a Claude account signs in with the CLI's own
// login in a Conductor terminal (the Accounts panel), and `auth.browser` is
// declared `unknown` until that is wired.
import type { ProviderAuthOperations, RealmRef, AuthOperationResult, AuthFailureCode, AuthStatusOptions, AuthLogoutOptions } from '../core'
import type { AuthRealm, KnownAuthState } from '../../../shared/providers'
import { claudeProfileOfRealm } from './review-launch'

/** A profile's sign-in as the app's probe reads it (ClaudeCliAuthStatus). */
export interface ClaudeProfileAuthStatus {
  authenticated: boolean
  /** Set when nothing could be determined. */
  error?: string
  /** Which source answered: the CLI's own status command, or the profile's
   *  credential file when the CLI did not answer. */
  source?: 'cli-status' | 'credential-file'
}

/** What the app's sign-out reports (ClaudeCliLogoutResult). */
export interface ClaudeProfileLogout {
  ran: boolean
  after: ClaudeProfileAuthStatus | null
  refused?: 'invalid-profile' | 'in-use' | 'no-home' | 'project-gate' | 'host-control' | 'cli-unavailable' | 'computer-sign-in'
  timedOut?: boolean
}

/** What the composition root hands the package for sign-in status and
 *  sign-out. */
export interface ClaudeAuthPorts {
  /** The registry's record of a live realm (a snapshot read, never the lock). */
  lookupRealm(ref: RealmRef): Promise<{ ok: true; realm: AuthRealm } | { ok: false }>
  /** One profile's `claude auth status`, as the Accounts panel reads it, run
   *  from `executable` (the file discovery proved) with no shell. */
  readStatus(profileId: string, executable: string): Promise<ClaudeProfileAuthStatus>
  /** One profile's `claude auth logout` run from `executable` with no shell,
   *  then its state read afresh. `acknowledged`: the user's yes to a sign-out
   *  that reaches this computer's own Claude Code sign-in. */
  logout(profileId: string, input: { executable: string; acknowledged: boolean }): Promise<ClaudeProfileLogout>
}

/** The package's own discovery, for the auth operations: the executable it
 *  last proved, checked again now (createClaudeReviewLaunch). */
export interface ClaudeAuthCli {
  executable(): Promise<{ ok: true; executable: string } | { ok: false; code: AuthFailureCode; message?: string }>
}

/** Why a sign-out of this computer's own Claude Code sign-in needs a yes: the
 *  primary profile shares it with the user's own Claude Code login, and on
 *  macOS every profile runs on it (D2). The CLI also revokes its token. */
export const CLAUDE_COMPUTER_SIGN_IN_ACK = 'This is the Claude Code sign-in this computer uses outside the app too. Signing it out signs out every Claude Code that uses it here. Confirm to continue.'

/** Why nothing ran: discovery has proved no Claude Code this app can run. */
const CLAUDE_CLI_UNAVAILABLE = 'Claude Code was not found, or is older than this app needs. Check again in Settings, Accounts.'

/** Why the project gate stopped a sign-out (the file and keys are in the log). */
const CLAUDE_SIGN_OUT_GATE_REFUSAL = 'Claude Code settings in the folder it would run from could redirect this account, so the sign-out was not run. The app log names the file.'

/** Why a sign-out's environment could not be prepared (the reason is in the log). */
const CLAUDE_SIGN_OUT_NOT_PREPARED = 'The app could not prepare this account\'s Claude Code environment, so the sign-out was not run. The app log has the reason.'

type Status = { state: KnownAuthState } & AuthOperationResult
const refuse = (code: AuthFailureCode, message?: string): AuthOperationResult => ({ ok: false, code, ...(message ? { message } : {}) })
const unread = (code: AuthFailureCode, message?: string): Status => ({ ok: false, code, state: 'error', ...(message ? { message } : {}) })

export function createClaudeAuthOperations(ports: ClaudeAuthPorts, cli: ClaudeAuthCli | null): ProviderAuthOperations {
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

  /** The executable discovery proved, or why there is none: no discovery in
   *  this package, a failed check, or a throw is no executable. The
   *  discovery's own words are the reviewer's, so the reason here is ours. */
  const executable = async (): Promise<{ ok: true; executable: string } | { ok: false; code: AuthFailureCode; message: string }> => {
    const none = { ok: false as const, code: 'cli-unavailable' as const, message: CLAUDE_CLI_UNAVAILABLE }
    if (!cli) return none
    try {
      const e = await cli.executable()
      return e && e.ok === true && typeof e.executable === 'string' && e.executable ? e : none
    } catch {
      return none
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
      const exe = await executable()
      if (!exe.ok) return unread(exe.code, exe.message)
      if (opts?.signal?.aborted) return unread('cancelled')
      let read: ClaudeProfileAuthStatus
      try {
        read = await ports.readStatus(profileId, exe.executable)
      } catch {
        return unread('not-started')
      }
      // A check no longer wanted answers no state (AuthStatusOptions).
      if (opts?.signal?.aborted) return unread('cancelled')
      // "Signed out" only from the CLI itself: when it did not answer (absent,
      // slow, refused), the probe falls back to the profile's credential file,
      // and that file's absence is no evidence (on macOS the sign-in is in the
      // keychain, never in the file).
      if (read && typeof read === 'object' && read.authenticated === false && read.source !== 'cli-status') return unread('status-unrecognised')
      return stateOf(read)
    },

    async logout(realm: RealmRef, opts?: AuthLogoutOptions): Promise<AuthOperationResult> {
      const profileId = await profileOf(realm)
      if (!profileId) return refuse('realm-unavailable')
      const exe = await executable()
      if (!exe.ok) return refuse(exe.code, exe.message)
      let out: ClaudeProfileLogout
      try {
        out = await ports.logout(profileId, { executable: exe.executable, acknowledged: opts?.acknowledgeExternalRealm === true })
      } catch {
        return refuse('not-started')
      }
      if (!out || typeof out !== 'object') return refuse('not-started')
      if (out.refused === 'computer-sign-in') return refuse('external-ack-required', CLAUDE_COMPUTER_SIGN_IN_ACK)
      if (out.refused === 'in-use') return refuse('busy', 'Something is using this Claude account (a session, or a check of it). Close it, then sign out.')
      if (out.refused === 'invalid-profile' || out.refused === 'no-home') return refuse('realm-unavailable')
      if (out.refused === 'cli-unavailable') return refuse('cli-unavailable', CLAUDE_CLI_UNAVAILABLE)
      if (out.refused === 'project-gate') return refuse('not-started', CLAUDE_SIGN_OUT_GATE_REFUSAL)
      if (out.refused === 'host-control') return refuse('not-started', CLAUDE_SIGN_OUT_NOT_PREPARED)
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
