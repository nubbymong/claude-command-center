import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  getTokenomicsData,
  seedTokenomics,
  syncTokenomics,
} from '../tokenomics-manager'

export function registerTokenomicsHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.TOKENOMICS_GET_DATA, async () => {
    return getTokenomicsData()
  })

  ipcMain.handle(IPC.TOKENOMICS_SEED, async () => {
    return seedTokenomics(getWindow)
  })

  ipcMain.handle(IPC.TOKENOMICS_SYNC, async () => {
    return syncTokenomics(getWindow)
  })
}
