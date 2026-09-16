/**
 * The application menu. Lifted out of `index.ts` (2.1.1) as a pure move.
 */
import { Menu } from 'electron'

// Set up application menu with Edit roles so Ctrl+C/V/X/A work in frameless window
// On macOS, include the app name menu (About, Hide, Quit) and Window menu (macOS convention)
export function buildAndSetAppMenu(): void {
  const menuTemplate: Electron.MenuItemConstructorOptions[] = []

  if (process.platform === 'darwin') {
    menuTemplate.push({
      // app.name is the npm package name ('claude-conductor', frozen for the
      // userData path) — hardcode the display name instead.
      label: 'AI Code Conductor',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  menuTemplate.push({
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  })

  if (process.platform === 'darwin') {
    menuTemplate.push({
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    })
  }

  const menu = Menu.buildFromTemplate(menuTemplate)
  Menu.setApplicationMenu(menu)
}
