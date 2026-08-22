/**
 * desktop-import-handlers.ts — IPC seam for the desktop-chat import (#209).
 *
 * Every handler returns a RESULT ENVELOPE (`{ok:true, …}` / `{ok:false, error}`)
 * rather than throwing across the bridge: the renderer shows these errors to the
 * user verbatim, and a rejected `invoke` arrives as an opaque
 * "Error invoking remote method" string that tells them nothing.
 *
 * Every input is zod-validated HERE, at the boundary, before it reaches a module
 * that touches the network, the filesystem, or a child process.
 *
 * No default export (project convention).
 */

import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import { type ParsedTranscript } from '../../shared/desktop-import'
import { logError } from '../debug-logger'
import { resolveCwd } from '../path-utils'
import { parsePastedTranscript } from '../desktop-import/parse-transcript'
import { importFromShareLink } from '../desktop-import/share-link'
import { generateBrief } from '../desktop-import/brief'
import { writeBriefFile } from '../desktop-import/brief-file'
import { pasteSchema, transcriptSchema, writeBriefArgsSchema, fromShareArgsSchema } from './desktop-import-schemas'

type Ok<T> = { ok: true } & T
type Err = { ok: false; error: string }

function fail(scope: string, err: unknown): Err {
  const error = (err as Error)?.message ?? String(err)
  logError(`[desktop-import] ${scope}: ${error}`)
  return { ok: false, error }
}

/**
 * In-flight cap on the headless summariser (adversarial review, #209). Each
 * buildBrief spawns a `claude -p` child that can run for up to 180 s; without a
 * cap, a renderer looping the IPC call spawns an unbounded fleet of them. Two at
 * once covers a user regenerating while another is mid-flight; beyond that the
 * call is refused rather than queued (a brief is not latency-critical).
 */
const MAX_CONCURRENT_BRIEFS = 2
let briefsInFlight = 0

export function registerDesktopImportHandlers(): void {
  ipcMain.handle(IPC.DESKTOP_IMPORT_PARSE_PASTE, async (_e, raw: unknown) => {
    try {
      return { ok: true, transcript: parsePastedTranscript(pasteSchema.parse(raw)) } as Ok<{
        transcript: ParsedTranscript
      }>
    } catch (err) {
      return fail('parsePaste', err)
    }
  })

  ipcMain.handle(IPC.DESKTOP_IMPORT_FROM_SHARE, async (_e, args: unknown) => {
    try {
      const { url, profileId } = fromShareArgsSchema.parse(args)
      return { ok: true, transcript: await importFromShareLink(url, profileId) }
    } catch (err) {
      return fail('fromShare', err)
    }
  })

  ipcMain.handle(IPC.DESKTOP_IMPORT_BUILD_BRIEF, async (_e, args: unknown) => {
    if (briefsInFlight >= MAX_CONCURRENT_BRIEFS) {
      return { ok: false, error: 'A brief is already being generated — wait for it to finish.' } as Err
    }
    briefsInFlight++
    try {
      const { transcript } = z.object({ transcript: transcriptSchema }).parse(args)
      return { ok: true, brief: await generateBrief(transcript as ParsedTranscript) }
    } catch (err) {
      return fail('buildBrief', err)
    } finally {
      briefsInFlight--
    }
  })

  ipcMain.handle(IPC.DESKTOP_IMPORT_WRITE_BRIEF, async (_e, args: unknown) => {
    try {
      const { workingDirectory, markdown } = writeBriefArgsSchema.parse(args)
      // resolveCwd is what the PTY itself uses, so the brief lands in the SAME
      // directory the session runs in. Resolving here rather than in
      // writeBriefFile matters: a config working directory of '.' or '~' would
      // otherwise resolve against the MAIN PROCESS's cwd and write the brief
      // somewhere the session will never look.
      return { ok: true, written: writeBriefFile(resolveCwd(workingDirectory), markdown) }
    } catch (err) {
      return fail('writeBrief', err)
    }
  })
}
