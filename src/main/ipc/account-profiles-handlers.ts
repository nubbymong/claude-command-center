// src/main/ipc/account-profiles-handlers.ts
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  listProfiles, upsertProfile, safeTeardownProfile,
  readProfileAccountEmail, getProfileConfigDir, isValidProfileId,
} from '../account-profiles'

export function registerAccountProfilesHandlers(): void {
  ipcMain.handle(IPC.ACCOUNT_PROFILES_LIST, () => listProfiles())

  ipcMain.handle(IPC.ACCOUNT_PROFILES_RENAME, (_e, p: { id: string; name: string }) => {
    if (!p || !isValidProfileId(p.id)) return { ok: false }
    const prof = listProfiles().find((x) => x.id === p.id)
    if (!prof) return { ok: false }
    upsertProfile({ ...prof, name: String(p.name ?? '').slice(0, 120) })
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
    }
    return { ok: true, email, configDir: getProfileConfigDir(p.id) }
  })
  // ACCOUNT_PROFILES_CREATE / ACCOUNT_PROFILES_ADD_ACCOUNT are wired in the migration phase.
}
