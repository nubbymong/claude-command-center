import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { HooksGateway } from '../hooks/hooks-gateway'
import type { HooksToggleRequest, HooksGetBufferRequest, HooksGatewayStatus } from '../../shared/hook-types'
import { getActivePtySessionIds } from '../pty-manager'
import { removeHooks } from '../hooks/session-hooks-writer'
import { getLocalSessionSettingsPath } from '../hooks/per-session-settings'

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
      // Master-toggle off: strip hook entries from every active session's
      // per-session settings file before stopping the gateway, so live
      // Claude processes stop POSTing to a dying endpoint on their next
      // /reload. SSH remote files are left stale — the remote session's
      // next hook POST 503s (gateway disabled) and the file gets cleaned
      // up next launch by boot-cleanup.
      for (const sid of getActivePtySessionIds()) {
        try {
          removeHooks({ settingsPath: getLocalSessionSettingsPath(sid) })
        } catch { /* file may not exist; next call handles missing path */ }
      }
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
