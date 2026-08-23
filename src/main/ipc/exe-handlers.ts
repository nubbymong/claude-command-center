/**
 * IPC for GUI-subsystem executables (#379).
 *
 * Channels the renderer can reach:
 *   exe:probe        — read-only. "What is the program on this command line?"
 *   exe:run:start    — spawn ONE GUI-subsystem PE from the console-less main
 *                      process with piped stdio, streaming its output back.
 *   exe:run:release  — stop capturing, LEAVE the program running.
 *   exe:run:cancel   — kill the program (only from an explicit user action).
 *
 * Every payload is Zod-validated HERE, before the runner is touched, following
 * `logs2-handlers.ts`. The runner enforces its own gate on top (GUI-subsystem PE
 * only, absolute path, no shell) -- see `gui-exe-runner.ts` for why that gate is
 * the load-bearing one and this validation is the outer bound.
 *
 * Output is sent to the WebContents that ASKED for the run, not broadcast. A
 * broadcast would also reach the claude.ai sign-in window and the artifacts
 * window, which host remote content; they have no preload and no `ipcRenderer`
 * today, so nothing could read it, but a captured program's stdout has no
 * business being delivered to a window showing someone else's page. (Review
 * MINOR-7.)
 */
import { ipcMain, webContents, type WebContents } from 'electron'
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

const runIdSchema = z
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

/** Send to one WebContents, by id, if it is still alive. */
function sendTo(id: number, channel: string, payload: CapturedRunChunk | CapturedRunExit): void {
  const wc: WebContents | null = webContents.fromId(id) ?? null
  if (wc && !wc.isDestroyed()) wc.send(channel, payload)
}

export function registerExeHandlers(): void {
  ipcMain.handle(IPC.EXE_PROBE, async (_e, args: unknown) => {
    const { command, cwd } = probeSchema.parse(args)
    return probeCommandExe(command, cwd)
  })

  ipcMain.handle(IPC.EXE_RUN_START, async (e, args: unknown) => {
    const { command, cwd } = runSchema.parse(args)
    // Capture the id, not the WebContents: the window can be gone by the time a
    // slow tool prints, and an id lookup fails safely where a stale reference
    // would throw.
    const senderId = e.sender.id
    return getRunner().start(
      { command, cwd },
      {
        onChunk: (chunk) => sendTo(senderId, IPC.EXE_RUN_DATA, chunk),
        onExit: (exit) => sendTo(senderId, IPC.EXE_RUN_EXIT, exit),
      },
    )
  })

  ipcMain.handle(IPC.EXE_RUN_RELEASE, (_e, args: unknown) => {
    const { runId } = runIdSchema.parse(args)
    return getRunner().release(runId)
  })

  ipcMain.handle(IPC.EXE_RUN_CANCEL, (_e, args: unknown) => {
    const { runId } = runIdSchema.parse(args)
    return getRunner().cancel(runId)
  })
}

/**
 * Stop capturing everything still running. Called on app quit.
 *
 * RELEASE, not cancel: these are the user's GUI applications, and quitting CCC
 * is not a reason to force-close a slicer they left open (review MAJOR-2).
 */
export function stopAllCapturedRuns(): void {
  runner?.releaseAll()
}
