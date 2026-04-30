import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import {
  readCodexAuthStatus,
  codexLoginWithApiKey,
  codexLoginChatgpt,
  codexLoginDeviceAuth,
  codexLogout,
  codexTestConnection,
} from '../providers/codex/auth'

export function registerCodexHandlers(): void {
  ipcMain.handle(IPC.CODEX_STATUS, async () => {
    return await readCodexAuthStatus()
  })

  ipcMain.handle(IPC.CODEX_LOGIN, async (_e, payload: { mode: 'chatgpt' | 'api-key' | 'device'; apiKey?: string }) => {
    if (payload.mode === 'api-key') {
      if (!payload.apiKey) return { ok: false, error: 'apiKey required' }
      return await codexLoginWithApiKey(payload.apiKey)
    }
    if (payload.mode === 'chatgpt') return await codexLoginChatgpt()
    if (payload.mode === 'device') return await codexLoginDeviceAuth()
    return { ok: false, error: `unknown login mode: ${payload.mode}` }
  })

  ipcMain.handle(IPC.CODEX_LOGOUT, async () => await codexLogout())
  ipcMain.handle(IPC.CODEX_TEST_CONNECTION, async () => await codexTestConnection())
}
