// Which renderer an IPC handler serves: the app's own window, its top frame
// only. One rule for the provider-neutral Accounts handlers and Claude's
// account-profile handlers (P3.2, ADR-009), so both answer only the app.
import type { BrowserWindow, IpcMainEvent, IpcMainInvokeEvent } from 'electron'

export function appWindowSender(getWindow: () => BrowserWindow | null): (e: IpcMainInvokeEvent | IpcMainEvent) => boolean {
  return (e) => {
    try {
      const win = getWindow()
      if (!win || win.isDestroyed()) return false
      if (e.sender !== win.webContents) return false
      // The window's own main frame, by identity (not "a frame without a
      // parent", which a fenced frame's root also is).
      const frame = e.senderFrame
      return !!frame && frame === win.webContents.mainFrame
    } catch {
      return false
    }
  }
}
