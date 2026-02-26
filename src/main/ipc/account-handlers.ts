import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { getAccounts, getActiveAccount, switchAccount, saveCurrentAs } from '../account-manager'

export function registerAccountHandlers(): void {
  ipcMain.handle(IPC.ACCOUNT_LIST, async () => {
    return getAccounts()
  })

  ipcMain.handle(IPC.ACCOUNT_GET_ACTIVE, async () => {
    return getActiveAccount()
  })

  ipcMain.handle(IPC.ACCOUNT_SWITCH, async (_event, id: string) => {
    return switchAccount(id)
  })

  ipcMain.handle(IPC.ACCOUNT_SAVE_CURRENT_AS, async (_event, id: string, label: string) => {
    return saveCurrentAs(id, label)
  })
}
