import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { HooksGateway } from '../hooks/hooks-gateway'
import type { HooksToggleRequest, HooksGetBufferRequest, HooksGatewayStatus } from '../../shared/hook-types'

function broadcastStatus(status: HooksGatewayStatus): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try { w.webContents.send(IPC.HOOKS_STATUS, status) } catch { /* destroyed */ }
    }
  }
}

export function registerHooksHandlers(gateway: HooksGateway): void {
  ipcMain.handle(IPC.HOOKS_TOGGLE, async (_e, req: HooksToggleRequest) => {
    let status: HooksGatewayStatus
    if (req.enabled) {
      status = await gateway.start()
    } else {
      await gateway.stop()
      status = gateway.status()
    }
    broadcastStatus(status)
    return status
  })

  ipcMain.handle(IPC.HOOKS_GET_BUFFER, async (_e, req: HooksGetBufferRequest) => {
    return gateway.getBuffer(req.sessionId)
  })

  ipcMain.handle(IPC.HOOKS_GET_STATUS, async () => gateway.status())
}
