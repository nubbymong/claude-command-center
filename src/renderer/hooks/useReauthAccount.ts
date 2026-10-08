import { useCallback } from 'react'
import { generateId } from '../utils/id'
import { useSessionStore } from '../stores/sessionStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { resolveAccountName } from '../../shared/account-chip-color'
import type { AccountProfile } from '../../shared/account-types'

// Re-auth of an EXISTING account (its stored token expired). Same mechanism as
// useAddAccount — open a shell-only login session pinned to the profile and
// poll until /login rewrites the account's credentials — but targets the
// existing profileId instead of creating a new one. A full fresh login writes a
// complete credential set into that account's isolated home, so it sidesteps
// the rotating-refresh-token hazard of a silent refresh entirely.
const POLL_MS = 4000
const MAX_ATTEMPTS = 300 // ~20 min backstop; the session-gone check is the real bound

type StampRead = { ok?: boolean; stamp: string | null; signedIn: boolean; unknown?: boolean } | null | undefined

/** A stamp read that can serve as a baseline: a definite answer. A read main
 *  marks `unknown` (a locked macOS Keychain) is not one -- taking it as "no
 *  stamp" made the first read after an unlock look like a fresh sign-in
 *  (adversarial review pass 3, m7). Exported for testing. */
export function knownStamp(r: StampRead): r is { stamp: string | null; signedIn: boolean } {
  return !!r && r.unknown !== true
}

/** Whether the re-auth is still pending, given the baseline taken when the
 *  shell opened (undefined = no definite baseline yet) and the latest read.
 *  Never completes from an unknown baseline or on an unknown read. Exported
 *  for testing. */
export function reauthPending(baseline: string | null | undefined, now: StampRead): boolean {
  if (baseline === undefined) return true
  if (!knownStamp(now)) return true
  return !now.signedIn || now.stamp === baseline
}

function pollForReauth(profileId: string, sessionId: string, onDone: () => void): void {
  let attempts = 0
  // rc.14 review F7 (aicc_planning#51): an EXPIRED account still has its email
  // on disk, so "refreshIdentity returned an email" is true on the very first
  // tick and used to complete a re-auth that had not happened -- the login
  // guidance vanished after 4 s and a later real login was never observed.
  // Completion now also needs the CREDENTIALS to have changed since the shell
  // opened, and to read as signed in. The stamp is stat-only (no token crosses
  // the bridge). An older preload without the stamp API keeps the old rule.
  const stampApi = window.electronAPI.accountProfiles.credentialStamp
  // undefined until a DEFINITE read returns. An unknown or failed read leaves
  // it unset, and every tick retries it before anything can complete.
  let baseline: string | null | undefined
  let baselineInFlight = false
  const takeBaseline = async (): Promise<void> => {
    if (!stampApi || baseline !== undefined || baselineInFlight) return
    baselineInFlight = true
    try {
      // r9: the baseline read bypasses main's 30 s unknown cache.
      const r = await stampApi(profileId, { fresh: true })
      if (knownStamp(r)) baseline = r.stamp
    } catch { /* stays unset; retried next tick */ } finally { baselineInFlight = false }
  }
  void takeBaseline()
  const timer = setInterval(async () => {
    attempts++
    const exists = useSessionStore.getState().sessions.some((s) => s.id === sessionId)
    if (!exists) { clearInterval(timer); return } // session closed -> stop
    try {
      const res = await window.electronAPI.accountProfiles.refreshIdentity(profileId)
      // Unchanged credentials (or a baseline not yet read) = still pending. Falls
      // through to the attempt backstop below rather than returning, so an
      // abandoned login tab stops polling after ~20 min like any other.
      let pending = false
      if (res && res.email && stampApi) {
        if (baseline === undefined) {
          // No definite baseline yet: this tick only tries to take one.
          await takeBaseline()
          pending = true
        } else {
          pending = reauthPending(baseline, await stampApi(profileId))
        }
      }
      if (res && res.email && !pending) {
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

/**
 * Tab label for a re-auth login shell. Exported for testing.
 *
 * `AccountProfile.name` is documented as defaulting to "Personal · <localpart>",
 * but in practice it can be an empty string — every profile on a real machine had
 * `name: ''`. The label used to be `profile.name` verbatim, so those accounts
 * opened a login tab with NO NAME AT ALL, which is unusable when you are signing
 * two accounts back in and have to tell the tabs apart. The email is the reliable
 * identifier, so it is the fallback rather than an afterthought.
 *
 * Prefixed because a bare account name is indistinguishable from an ordinary
 * session for that same account, and this tab is only good for one thing.
 */
export function reauthTabLabel(
  hint: string | undefined,
  profile: Pick<AccountProfile, 'name' | 'accountEmail'> | undefined,
  aliases: Record<string, string> | undefined
): string {
  const email = profile?.accountEmail?.trim() ?? ''
  const display =
    hint?.trim() ||
    profile?.name?.trim() ||
    (email ? resolveAccountName(email, profile?.name, aliases) : '') ||
    'account'
  return `Sign in: ${display}`
}

/** Open a login shell for an EXISTING account so the user can re-authenticate
 *  it, then run `onDone` (e.g. re-fetch usage) once the login lands. Returns the
 *  new login session id; the caller should switch to the sessions view. */
export function useReauthAccount(): (profile: Pick<AccountProfile, 'id' | 'name'>, onDone?: () => void) => string {
  const addSession = useSessionStore((s) => s.addSession)
  return useCallback((profile, onDone) => {
    const sessionId = generateId()
    // Resolved here rather than trusted from the caller: the label has to be
    // right no matter which entry point opened the login (the Insights banner,
    // the account-usage panel, or anything added later).
    const stored = useAccountProfilesStore.getState().profiles.find((p) => p.id === profile.id)
    const aliases = useSettingsStore.getState().settings.accountAliases
    addSession({
      id: sessionId,
      label: reauthTabLabel(profile.name, stored, aliases),
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
