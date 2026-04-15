import { ipcMain, BrowserWindow } from 'electron'
import {
  initCloudAgentManager,
  cleanupStuckAgents,
  dispatchAgent,
  cancelAgent,
  removeAgent,
  retryAgent,
  listAgents,
  getAgentOutput,
  clearCompletedAgents,
} from '../cloud-agent-manager'

export function registerCloudAgentHandlers(getWindow: () => BrowserWindow | null): void {
  initCloudAgentManager(getWindow)
  cleanupStuckAgents()

  ipcMain.handle('cloudAgent:dispatch', async (_event, params: {
    name: string
    description: string
    projectPath: string
    configId?: string
    legacyVersion?: { enabled: boolean; version: string }
  }) => {
    return dispatchAgent(params)
  })

  ipcMain.handle('cloudAgent:cancel', async (_event, id: string) => {
    return cancelAgent(id)
  })

  ipcMain.handle('cloudAgent:remove', async (_event, id: string) => {
    return removeAgent(id)
  })

  ipcMain.handle('cloudAgent:retry', async (_event, id: string) => {
    return retryAgent(id)
  })

  ipcMain.handle('cloudAgent:list', async () => {
    return listAgents()
  })

  ipcMain.handle('cloudAgent:getOutput', async (_event, id: string) => {
    return getAgentOutput(id)
  })

  ipcMain.handle('cloudAgent:clearCompleted', async () => {
    return clearCompletedAgents()
  })
}
