import { ipcMain, BrowserWindow } from 'electron'
import {
  runInsights,
  seedFromExisting,
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
  ipcMain.handle('insights:run', async () => {
    return runInsights(getWindow)
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

  // Seed: just copy existing report.html into archive (no KPI extraction, no tokens)
  // Only runs if catalogue is empty and a report exists
  ipcMain.handle('insights:seed', async () => {
    const catalogue = getCatalogue()
    if (catalogue.runs.length > 0) return null
    return seedFromExisting(getWindow)
  })
}
