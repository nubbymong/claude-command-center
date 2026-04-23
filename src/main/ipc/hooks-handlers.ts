import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { HooksGateway } from '../hooks/hooks-gateway'
import type { HooksToggleRequest, HooksGetBufferRequest } from '../../shared/hook-types'

export function registerHooksHandlers(gateway: HooksGateway): void {
  ipcMain.handle(IPC.HOOKS_TOGGLE, async (_e, req: HooksToggleRequest) => {
    if (req.enabled) return gateway.start()
    await gateway.stop()
    return gateway.status()
  })

  ipcMain.handle(IPC.HOOKS_GET_BUFFER, async (_e, req: HooksGetBufferRequest) => {
    return gateway.getBuffer(req.sessionId)
  })

  ipcMain.handle(IPC.HOOKS_GET_STATUS, async () => gateway.status())
}
