import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { spawnSideChat, killSideChat, extractParentContext } from '../side-chat-manager'

export function registerSideChatHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.SIDE_CHAT_SPAWN, (_event, parentSessionId: string, options?: { cols?: number; rows?: number }) => {
    const win = getWindow()
    if (!win) throw new Error('No window available')
    // The renderer should pass session details; for now use defaults
    // Full session details will be passed via the options in the renderer integration
    return spawnSideChat(win, parentSessionId, {
      workingDirectory: '.',
      parentLabel: 'Session',
      cols: options?.cols,
      rows: options?.rows,
    })
  })

  ipcMain.on(IPC.SIDE_CHAT_KILL, (_event, sideChatSessionId: string) => {
    killSideChat(sideChatSessionId)
  })

  ipcMain.handle(IPC.SIDE_CHAT_GET_CONTEXT, (_event, parentSessionId: string) => {
    return extractParentContext(parentSessionId)
  })
}
