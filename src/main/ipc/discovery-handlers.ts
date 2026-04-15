import { ipcMain } from 'electron'
import { discoverProjects, discoverSessions } from '../session-discovery'

export function registerDiscoveryHandlers(): void {
  ipcMain.handle('discovery:projects', async () => {
    return discoverProjects()
  })

  ipcMain.handle('discovery:sessions', async (_event, projectPath: string) => {
    return discoverSessions(projectPath)
  })
}
