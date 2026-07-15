import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import {
  readCodexAuthStatus,
  codexLoginWithApiKey,
  codexLoginChatgpt,
  codexLoginDeviceAuth,
  codexLogout,
  codexTestConnection,
} from '../providers/codex/auth'

const codexLoginPayloadSchema = z.object({
  mode: z.enum(['chatgpt', 'api-key', 'device']),
  apiKey: z.string().min(1).max(500).optional(),
})

export function registerCodexHandlers(): void {
  ipcMain.handle(IPC.CODEX_STATUS, async () => {
    return await readCodexAuthStatus()
  })

  ipcMain.handle(IPC.CODEX_LOGIN, async (_e, payload: unknown) => {
    const parsed = codexLoginPayloadSchema.safeParse(payload)
    if (!parsed.success) {
      return { ok: false, error: `Invalid parameters: ${parsed.error.message}` }
    }
    const { mode, apiKey } = parsed.data
    if (mode === 'api-key') {
      if (!apiKey) return { ok: false, error: 'apiKey required' }
      return await codexLoginWithApiKey(apiKey)
    }
    if (mode === 'chatgpt') return await codexLoginChatgpt()
    if (mode === 'device') return await codexLoginDeviceAuth()
    return { ok: false, error: `unknown login mode: ${mode}` }
  })

  ipcMain.handle(IPC.CODEX_LOGOUT, async () => await codexLogout())
  ipcMain.handle(IPC.CODEX_TEST_CONNECTION, async () => await codexTestConnection())
}
