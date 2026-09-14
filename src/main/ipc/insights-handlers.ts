import { ipcMain, BrowserWindow } from 'electron'
import {
  runInsights,
  runCrossAccountInsights,
  getCatalogue,
  getInsightsReport,
  getInsightsKpis,
  getLatestRun,
  isRunning,
  isValidRunId,
  cleanupStuckRuns
} from '../insights-runner'
import { isValidProfileId } from '../account-profiles'

export function registerInsightsHandlers(getWindow: () => BrowserWindow | null): void {
  // On startup, mark any stuck runs as failed
  cleanupStuckRuns()
  // The profileId becomes a path component (and the run's HOME) once it reaches
  // resolveInsightsAccount. Drop an invalid one at the boundary rather than
  // forwarding it: the runner then resolves the primary account, which is
  // exactly what already happens for a profileId whose directory is missing.
  ipcMain.handle('insights:run', async (_event, opts?: { profileId?: string }) => {
    const profileId = isValidProfileId(opts?.profileId) ? opts.profileId : undefined
    return runInsights(getWindow, profileId ? { profileId } : undefined)
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

  // Guarded at the boundary AND inside the runner: the renderer's runId becomes a
  // path component, so a crafted id is rejected before it reaches any join. Two
  // layers on purpose — a future caller of the runner cannot bypass the check by
  // not going through this handler.
  ipcMain.handle('insights:getReport', async (_event, runId: string) => {
    if (!isValidRunId(runId)) return null
    return getInsightsReport(runId)
  })

  ipcMain.handle('insights:getKpis', async (_event, runId: string) => {
    if (!isValidRunId(runId)) return null
    return getInsightsKpis(runId)
  })

  ipcMain.handle('insights:getLatest', async () => {
    return getLatestRun()
  })

  ipcMain.handle('insights:isRunning', async () => {
    return isRunning()
  })
}
