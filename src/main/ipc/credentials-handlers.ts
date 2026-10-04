import { ipcMain } from 'electron'
import { saveCredential, deleteCredential } from '../credential-store'
import { isAllowedCredentialKey } from '../credential-key'
import { logWarn } from '../debug-logger'

/**
 * The renderer's two doors into the credential store. A credential's VALUE is
 * never handed back (there is deliberately no `credentials:load`; values are
 * injected into the shell environment at spawn by pty-handlers). Both doors
 * accept only keys of the app's own shape (see credential-key.ts) -- anything
 * else is refused, never written or deleted, and logged (except a delete of an
 * id the save door would never have taken: there is nothing to delete).
 */
export function registerCredentialHandlers(): void {
  ipcMain.handle('credentials:save', async (_event, key: unknown, password: unknown) => {
    if (!isAllowedCredentialKey(key) || typeof password !== 'string') {
      logWarn('[credentials] save refused: key or value not of the expected shape')
      return false
    }
    return saveCredential(key, password)
  })

  ipcMain.handle('credentials:delete', async (_event, key: unknown) => {
    if (!isAllowedCredentialKey(key)) {
      // No credential can be stored under an id the save door above refuses:
      // that door is the only one that adds an entry, and it applies this same
      // rule. So the delete has nothing to do and is skipped quietly -- configs
      // whose ids came from outside the app (imported or seeded) ask for it on
      // every edit-save. A key that is not a string at all is a malformed
      // request and is still logged. Either way the store is never touched.
      if (typeof key !== 'string') logWarn('[credentials] delete refused: key not of the expected shape')
      return false
    }
    const deleted = deleteCredential(key)
    // An id that can hold a credential, and the store could not delete it (the
    // file could not be read, or the write failed): it may still be stored.
    if (!deleted) logWarn('[credentials] delete refused: the credential store could not be read or written')
    return deleted
  })
}
