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
  ipcMain.handle(IPC.ACCOUNT_USAGE_FETCH_ONE, (_e, p: { id: string }) =>
    p && isValidProfileId(p.id) ? fetchAccountUsage(p.id) : null,
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

  ipcMain.handle(IPC.ACCOUNT_PROFILES_DELETE, (_e, p: { id: string }) => {
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
