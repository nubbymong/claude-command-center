import { ipcMain, BrowserWindow } from 'electron'
import {
  runInsights,
  getCatalogue,
  getInsightsReport,
  getInsightsKpis,
  getLatestRun,
  isRunning,
  cleanupStuckRuns
} from '../insights-runner'

export function registerInsightsHandlers(getWindow: () => BrowserWindow | null): void {
  // On startup, mark any stuck runs as failed
  cleanupStuckRuns()
  ipcMain.handle('insights:run', async (_event, opts?: { profileId?: string }) => {
    return runInsights(getWindow, opts)
  })

  ipcMain.handle('insights:getCatalogue', async () => {
    return getCatalogue()
  })

  ipcMain.handle('insights:getReport', async (_event, runId: string) => {
    return getInsightsReport(runId)
  })

  ipcMain.handle('insights:getKpis', async (_event, runId: string) => {
    return getInsightsKpis(runId)
  })

  ipcMain.handle('insights:getLatest', async () => {
    return getLatestRun()
  })

  ipcMain.handle('insights:isRunning', async () => {
    return isRunning()
  })
}
