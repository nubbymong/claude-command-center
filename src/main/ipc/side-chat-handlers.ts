import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { spawnSideChat, killSideChat } from '../side-chat-manager'

export function registerSideChatHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.SIDE_CHAT_SPAWN, (_event, parentSessionId: string, options?: {
    cols?: number; rows?: number
    workingDirectory?: string; parentLabel?: string
    model?: string; contextPercent?: number
    ssh?: { host: string; port: number; username: string; remotePath: string; postCommand?: string }
  }) => {
    const win = getWindow()
    if (!win) throw new Error('No window available')
    return spawnSideChat(win, parentSessionId, {
      workingDirectory: options?.workingDirectory || '.',
      parentLabel: options?.parentLabel || 'Session',
      model: options?.model,
      contextPercent: options?.contextPercent,
      ssh: options?.ssh,
      cols: options?.cols,
      rows: options?.rows,
    })
  })

  ipcMain.on(IPC.SIDE_CHAT_KILL, (_event, sideChatSessionId: string) => {
    killSideChat(sideChatSessionId)
  })
}
