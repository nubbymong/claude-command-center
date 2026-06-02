// src/main/ipc/account-profiles-handlers.ts
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  listProfiles, upsertProfile, safeTeardownProfile,
  readProfileAccountEmail, getProfileConfigDir, isValidProfileId, createProfile,
  captureDetectedAccount, backupProfileHomeToCanonical,
} from '../account-profiles'
import { getAccountIdentity, getDefaultAccountEmail } from '../claude-account-identity'

export function registerAccountProfilesHandlers(): void {
  ipcMain.handle(IPC.ACCOUNT_PROFILES_LIST, () => listProfiles())

  // Renderer pull: the reliable per-session account identity captured at spawn.
  ipcMain.handle(IPC.ACCOUNT_IDENTITY_GET, (_e, p: { sessionId: string }) => (p?.sessionId ? getAccountIdentity(p.sessionId) : null))

  ipcMain.handle(IPC.ACCOUNT_PROFILES_RENAME, (_e, p: { id: string; name: string }) => {
    if (!p || !isValidProfileId(p.id)) return { ok: false }
    const prof = listProfiles().find((x) => x.id === p.id)
    if (!prof) return { ok: false }
    upsertProfile({ ...prof, name: String(p.name ?? '').trim().slice(0, 120) })
    return { ok: true }
  })

  ipcMain.handle(IPC.ACCOUNT_PROFILES_DELETE, (_e, p: { id: string }) => {
    // safeTeardownProfile validates the id + asserts path containment + refuses a
    // reparse-point root; it throws on an invalid/escaping id.
    if (!p || !isValidProfileId(p.id)) return { ok: false }
    safeTeardownProfile(p.id)
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
    return captureDetectedAccount(p.sessionId, p.name)
  })
  ipcMain.handle(IPC.ACCOUNT_GLOBAL_EMAIL_GET, () => getDefaultAccountEmail())
}
