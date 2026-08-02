import { ipcMain, BrowserWindow } from 'electron'
import {
  runInsights,
  runCrossAccountInsights,
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

  // Cross-account roll-up. The id list is narrowed to strings here and
  // intersected with the real on-disk profiles inside the runner, so a bogus id
  // from the renderer can only ever shrink the target set, never widen it or
  // reach a path.
  ipcMain.handle('insights:runAll', async (_event, opts?: { profileIds?: string[] }) => {
    const profileIds = Array.isArray(opts?.profileIds)
      ? opts!.profileIds!.filter((id): id is string => typeof id === 'string')
      : undefined
    return runCrossAccountInsights(getWindow, profileIds ? { profileIds } : undefined)
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
