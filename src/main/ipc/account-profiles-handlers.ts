// src/main/ipc/account-profiles-handlers.ts
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  listProfiles, upsertProfile, safeTeardownProfile,
  readProfileAccountEmail, getProfileConfigDir, isValidProfileId, createProfile,
  captureDetectedAccount, backupProfileHomeToCanonical, restoreProfileHomeFromCanonical,
} from '../account-profiles'
import { isAccountActive } from '../../shared/account-types'
import { getAccountIdentity, getDefaultAccountEmail, getWatchedProfileId, isProfileInUseByLiveSession } from '../claude-account-identity'
import { fetchAllAccountsUsage, fetchAccountUsage } from '../usage/account-usage'
import { readAllProfileAuthInfo } from '../account-auth-info'
import { logError } from '../debug-logger'
import { clearWebSession } from '../account-web/sign-in'
import { removeWebSession } from '../account-web/session-store'
import { closeArtifacts } from '../account-web/artifacts'
import { closeAccountPanesForProfile } from '../account-web/account-pane'

export function registerAccountProfilesHandlers(): void {
  ipcMain.handle(IPC.ACCOUNT_PROFILES_LIST, () => listProfiles())

  // Credential state per profile: days until a forced login, plus the identity
  // cross-check. Pure file reads, so it is safe to call on every panel open.
  ipcMain.handle(IPC.ACCOUNT_PROFILES_AUTH_INFO, () => {
    try {
      return readAllProfileAuthInfo()
    } catch (err) {
      logError('[account-profiles] authInfo failed:', err)
      return []
    }
  })

  // All-accounts usage overview: fetch each profile's usage directly (no session).
  ipcMain.handle(IPC.ACCOUNT_USAGE_FETCH_ALL, () => fetchAllAccountsUsage())
  ipcMain.handle(IPC.ACCOUNT_USAGE_FETCH_ONE, (_e, p: { id: string; noRefresh?: boolean }) =>
    // `!!p.noRefresh`, not `=== true` (adversarial review): a hostile/garbled
    // noRefresh must fail toward NOT rotating the token (a stale number), never
    // toward a rotation that could strand a respawning session. Junk is truthy
    // → suppress; only a real falsy/absent value (the panel's normal call)
    // allows the idle-account refresh.
    p && isValidProfileId(p.id) ? fetchAccountUsage(p.id, { noRefresh: !!p.noRefresh }) : null,
  )

  // Renderer pull: the reliable per-session account identity captured at spawn.
  ipcMain.handle(IPC.ACCOUNT_IDENTITY_GET, (_e, p: { sessionId: string }) => (p?.sessionId ? getAccountIdentity(p.sessionId) : null))

  ipcMain.handle(IPC.ACCOUNT_PROFILES_RENAME, (_e, p: { id: string; name: string }) => {
    if (!p || !isValidProfileId(p.id)) return { ok: false }
    const prof = listProfiles().find((x) => x.id === p.id)
    if (!prof) return { ok: false }
    upsertProfile({ ...prof, name: String(p.name ?? '').trim().slice(0, 120) })
    return { ok: true }
  })

  // Mark an account active/inactive. Inactive accounts stay listed but cannot be
  // chosen when switching a session's account (enforced in the switch surfaces
  // and, as a backstop, in useSwitchAccount).
  ipcMain.handle(IPC.ACCOUNT_PROFILES_SET_ACTIVE, (_e, p: { id: string; active: boolean }) => {
    if (!p || !isValidProfileId(p.id)) return { ok: false }
    const profs = listProfiles()
    const prof = profs.find((x) => x.id === p.id)
    if (!prof) return { ok: false }
    // The primary account is always active -- it can't be deleted either, and
    // keeping it selectable guarantees the switcher can never be left empty.
    if (prof.isPrimary && p.active === false) {
      return { ok: false, error: 'The primary account cannot be deactivated.' }
    }
    // Backstop for machines that never captured a primary (the default global was
    // never logged in): refuse to deactivate the LAST active account, otherwise
    // the switcher and the launch gate would have nothing selectable left.
    if (p.active === false && !profs.some((x) => x.id !== p.id && isAccountActive(x))) {
      return { ok: false, error: 'At least one account must stay active.' }
    }
    upsertProfile({ ...prof, active: p.active !== false })
    return { ok: true }
  })

  // ASYNC because the delete now AWAITS the web-session clear before it destroys
  // anything (#216). Losing the `async` here in a merge would make that await a
  // no-op returned to the caller and quietly restore the bug it fixed.
  ipcMain.handle(IPC.ACCOUNT_PROFILES_DELETE, async (_e, p: { id: string }) => {
    // safeTeardownProfile validates the id + asserts path containment + refuses a
    // reparse-point root; it throws on an invalid/escaping id.
    if (!p || !isValidProfileId(p.id)) return { ok: false, error: 'invalid profile id' }
    // R-006: refuse to delete a profile that a live session is running under -- the
    // profile dir is that session's active USERPROFILE/credential store, so a teardown
    // mid-recursion would half-destroy its creds (auth breaks, token refresh fails) and
    // leave the metadata pointing at a gutted dir. Ask the user to close it first.
    if (isProfileInUseByLiveSession(p.id)) {
      return { ok: false, error: 'This account is in use by an open session. Close its sessions and try again.' }
    }
    // #216: the profile dir is not the whole account. This account's claude.ai
    // WEB session lives in an Electron partition, so without this a delete
    // leaves live cookies on disk indefinitely and an artifacts window open.
    //
    // CLEARED FIRST, AND AWAITED. Two orderings were wrong before this one.
    // Firing it off with `void` and dropping the record regardless left a live
    // session in `persist:claude-web-<id>` with nothing referencing it and
    // `ok: true` reported. Awaiting it AFTER safeTeardownProfile was no better:
    // that call already removes the profile dir and its metadata, so a failure
    // here returned "so it was not removed" about an account that was already
    // gone. Clearing before any destructive step is what makes that message
    // true, and it fails closed — the account survives to be deleted again.
    closeArtifacts(p.id)
    // The pane's account surfaces hold the same session (#439) — and the
    // in-use guard above cannot cover them: the Settings route deliberately
    // hosts account X's pane inside a session bound to another profile, so a
    // delete of X passes that guard with X's view still live.
    closeAccountPanesForProfile(p.id)
    try {
      await clearWebSession(p.id)
    } catch (err) {
      logError(`[account-profiles] could not clear the web session for ${p.id}:`, err)
      return {
        ok: false,
        error: `The account's claude.ai session could not be cleared, so the account was not removed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    // Drop the record next to the clear that made it meaningless, rather than
    // after the teardown below: if that throws, the account survives with a
    // record claiming a web session whose partition has already been wiped.
    removeWebSession(p.id)
    // safeTeardownProfile can throw on a Windows file lock (e.g. an actively-rewritten
    // .claude.json) mid-recursion -- return a structured failure instead of rejecting
    // the invoke, so the renderer can surface it rather than swallowing the rejection.
    try {
      safeTeardownProfile(p.id)
    } catch (err) {
      logError(`[account-profiles] delete failed for ${p.id}:`, err)
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.ACCOUNT_PROFILES_REFRESH_IDENTITY, (_e, p: { id: string }) => {
    if (!p || !isValidProfileId(p.id)) return { ok: false, email: null }
    const email = readProfileAccountEmail(p.id)
    if (email) {
      const prof = listProfiles().find((x) => x.id === p.id)
      if (prof) upsertProfile({ ...prof, accountEmail: email })
      // Ensure a canonical backup exists now (not just after the next restart),
      // so a later capture/restore always has a source to restore from.
      backupProfileHomeToCanonical(p.id)
    }
    return { ok: true, email, configDir: getProfileConfigDir(p.id) }
  })
  ipcMain.handle(IPC.ACCOUNT_PROFILES_CREATE, (_e, p: { name?: string }) => createProfile(p?.name))
  ipcMain.handle(IPC.ACCOUNT_PROFILES_CAPTURE_DETECTED, (_e, p: { sessionId: string; name?: string }) => {
    if (!p || !p.sessionId) return null
    // Bug 2: the /login wrote the new account into the session's SHARED profile home.
    // Resolve that profile, capture the new account out of it into a fresh profile,
    // then restore the source profile home from canonical so the source account's
    // other sessions (and its saved profile) recover.
    const profileId = getWatchedProfileId(p.sessionId)
    if (!profileId) return null
    const np = captureDetectedAccount(profileId, p.name)
    if (np) { try { restoreProfileHomeFromCanonical(profileId) } catch { /* best-effort */ } }
    return np
  })
  ipcMain.handle(IPC.ACCOUNT_GLOBAL_EMAIL_GET, () => getDefaultAccountEmail())
}
