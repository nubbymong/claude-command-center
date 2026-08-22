/**
 * IPC for GUI-subsystem executables (#379).
 *
 * Two channels the renderer can reach:
 *   exe:probe      — read-only. "What is the program on this command line?"
 *   exe:run:start  — spawn ONE GUI-subsystem PE from the console-less main
 *                    process with piped stdio, streaming its output back.
 *
 * Every payload is Zod-validated HERE, before the runner is touched, following
 * `logs2-handlers.ts`. The runner enforces its own gate on top (GUI-subsystem PE
 * only, absolute path, no shell) — see `gui-exe-runner.ts` for why that gate is
 * the load-bearing one and this validation is the outer bound.
 */
import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import { probeCommandExe } from '../gui-exe-probe'
import { createCapturedRunner, type CapturedRunner } from '../gui-exe-runner'
import { EXE_PROBE_MAX_COMMAND_LEN, type CapturedRunChunk, type CapturedRunExit } from '../../shared/gui-exe'

/** A cwd is a path, not a command line; the bound is generous but finite. */
const MAX_CWD_LEN = 4096

const probeSchema = z
  .object({
    command: z.string().min(1).max(EXE_PROBE_MAX_COMMAND_LEN),
    cwd: z.string().max(MAX_CWD_LEN).optional(),
  })
  .strict()

const runSchema = probeSchema

const cancelSchema = z
  .object({ runId: z.string().min(1).max(128) })
  .strict()

let runner: CapturedRunner | null = null

/** Test seam: the runner is created lazily so a test can install its own. */
export function __setCapturedRunnerForTests(next: CapturedRunner | null): void {
  runner = next
}

function getRunner(): CapturedRunner {
  if (!runner) runner = createCapturedRunner()
  return runner
}

function broadcast(channel: string, payload: CapturedRunChunk | CapturedRunExit): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerExeHandlers(): void {
  ipcMain.handle(IPC.EXE_PROBE, async (_e, args: unknown) => {
    const { command, cwd } = probeSchema.parse(args)
    return probeCommandExe(command, cwd)
  })

  ipcMain.handle(IPC.EXE_RUN_START, async (_e, args: unknown) => {
    const { command, cwd } = runSchema.parse(args)
    return getRunner().start(
      { command, cwd },
      {
        onChunk: (chunk) => broadcast(IPC.EXE_RUN_DATA, chunk),
        onExit: (exit) => broadcast(IPC.EXE_RUN_EXIT, exit),
      },
    )
  })

  ipcMain.handle(IPC.EXE_RUN_CANCEL, (_e, args: unknown) => {
    const { runId } = cancelSchema.parse(args)
    return getRunner().cancel(runId)
  })
}

/** Kill anything still running. Called on app quit. */
export function stopAllCapturedRuns(): void {
  runner?.cancelAll()
}
