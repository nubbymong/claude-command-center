import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { TeamTemplate } from '../../shared/types'
import {
  initTeamManager,
  listTeams,
  saveTeam,
  deleteTeam,
  listRuns,
  runTeam,
  cancelRun,
} from '../team-manager'

export function registerTeamHandlers(getWindow: () => BrowserWindow | null): void {
  initTeamManager(getWindow)

  ipcMain.handle(IPC.TEAM_LIST, async () => listTeams())

  ipcMain.handle(IPC.TEAM_SAVE, async (_event, team: TeamTemplate) => saveTeam(team))

  ipcMain.handle(IPC.TEAM_DELETE, async (_event, id: string) => deleteTeam(id))

  ipcMain.handle(IPC.TEAM_RUN, async (_event, teamId: string, projectPath?: string) =>
    runTeam(teamId, projectPath))

  ipcMain.handle(IPC.TEAM_CANCEL_RUN, async (_event, runId: string) => cancelRun(runId))

  ipcMain.handle(IPC.TEAM_LIST_RUNS, async () => listRuns())
}
