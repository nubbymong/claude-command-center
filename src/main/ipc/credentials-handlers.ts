import { ipcMain } from 'electron'
import { saveCredential, deleteCredential } from '../credential-store'
import { isAllowedCredentialKey } from '../credential-key'
import { logWarn } from '../debug-logger'

/**
 * The renderer's two doors into the credential store. A credential's VALUE is
 * never handed back (there is deliberately no `credentials:load`; values are
 * injected into the shell environment at spawn by pty-handlers). Both doors
 * accept only keys of the app's own shape (see credential-key.ts) -- anything
 * else is refused and logged, never written or deleted.
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
      logWarn('[credentials] delete refused: key not of the expected shape')
      return false
    }
    return deleteCredential(key)
  })
}
