import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { saveCredential, deleteCredential, readCredentialsFile } from '../credential-store'
import { isAllowedCredentialKey } from '../credential-key'
import { logWarn } from '../debug-logger'
import { appWindowSender } from './trusted-sender'

/**
 * The renderer's two doors into the credential store. A credential's VALUE is
 * never handed back (there is deliberately no `credentials:load`; values are
 * injected into the shell environment at spawn by pty-handlers). Both doors
 * answer only the app's own window, its main frame (trusted-sender.ts), and
 * accept only keys of the app's own shape (see credential-key.ts) -- anything
 * else is refused, never written or deleted, and logged (except a delete of an
 * id the store holds nothing under: there is nothing to delete).
 *
 * Registered once per process (index.ts, registerMainWindowIpc): `getWindow`
 * is read on every call, so both doors follow a re-created window and refuse
 * while there is none.
 */
export function registerCredentialHandlers(getWindow: () => BrowserWindow | null): void {
  const trusted = appWindowSender(getWindow)

  ipcMain.handle('credentials:save', async (event, key: unknown, password: unknown) => {
    if (!trusted(event)) {
      logWarn('[credentials] save refused: not the app window')
      return false
    }
    if (!isAllowedCredentialKey(key) || typeof password !== 'string') {
      logWarn('[credentials] save refused: key or value not of the expected shape')
      return false
    }
    return saveCredential(key, password)
  })

  ipcMain.handle('credentials:delete', async (event, key: unknown) => {
    if (!trusted(event)) {
      logWarn('[credentials] delete refused: not the app window')
      return false
    }
    if (!isAllowedCredentialKey(key)) {
      // A key that is not a string at all is a malformed request: logged.
      if (typeof key !== 'string') {
        logWarn('[credentials] delete refused: key not of the expected shape')
        return false
      }
      // In this build the save door above is the only one that adds an
      // entry, and it applies this same rule, so an id outside it usually has
      // nothing stored: configs whose ids came from outside the app (imported
      // or seeded) ask for this delete on every edit-save, and it is skipped
      // quietly. But a store written by an older build, before this rule,
      // can hold an entry under such an id (PR 4 review C-Q3), so the store is
      // read (never written) to warn when it holds one, or when it cannot be
      // read to tell.
      const stored = readCredentialsFile()
      if (stored === null) logWarn('[credentials] delete refused: key outside the expected shape, and the credential store could not be read to check it')
      else if (Object.prototype.hasOwnProperty.call(stored, key)) logWarn('[credentials] delete refused: a credential is stored under an id of an older shape, which the renderer cannot delete')
      return false
    }
    const deleted = deleteCredential(key)
    // An id that can hold a credential, and the store could not delete it (the
    // file could not be read, or the write failed): it may still be stored.
    if (!deleted) logWarn('[credentials] delete refused: the credential store could not be read or written')
    return deleted
  })
}
