import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { readCodexAuthStatus } from '../providers/codex/auth'

export function registerCodexHandlers(): void {
  ipcMain.handle(IPC.CODEX_STATUS, async () => {
    return await readCodexAuthStatus()
  })
}
