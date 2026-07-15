import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { getSentinelState, sentinelApply, sentinelRevert, sentinelSetStatus, sentinelRerun } from '../sentinel/index'

export function registerSentinelHandlers(): void {
  ipcMain.handle(IPC.SENTINEL_GET_STATE, () => getSentinelState()?.snapshot() ?? null)
  ipcMain.handle(IPC.SENTINEL_APPLY, (_e, findingId: string) => sentinelApply(String(findingId)))
  ipcMain.handle(IPC.SENTINEL_REVERT, (_e, findingId: string) => { sentinelRevert(String(findingId)) })
  ipcMain.handle(IPC.SENTINEL_SET_STATUS, (_e, findingId: string, status: string) => {
    if (status === 'dismissed' || status === 'muted') sentinelSetStatus(String(findingId), status)
  })
  ipcMain.handle(IPC.SENTINEL_RERUN, () => { void sentinelRerun() })
  getSentinelState()?.subscribe((snap) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send(IPC.SENTINEL_STATE_UPDATE, snap) } catch { /* destroyed */ }
    }
  })
}
