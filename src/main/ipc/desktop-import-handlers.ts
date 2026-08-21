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
import { MAX_TRANSCRIPT_CHARS, type ParsedTranscript } from '../../shared/desktop-import'
import { logError } from '../debug-logger'
import { resolveCwd } from '../path-utils'
import { parsePastedTranscript } from '../desktop-import/parse-transcript'
import { importFromShareLink } from '../desktop-import/share-link'
import { generateBrief } from '../desktop-import/brief'
import { writeBriefFile } from '../desktop-import/brief-file'

type Ok<T> = { ok: true } & T
type Err = { ok: false; error: string }

function fail(scope: string, err: unknown): Err {
  const error = (err as Error)?.message ?? String(err)
  logError(`[desktop-import] ${scope}: ${error}`)
  return { ok: false, error }
}

// A pasted transcript is bounded at the IPC seam as well as in the parser — the
// parser truncates, but we never want a 100 MB string crossing the bridge first.
const pasteSchema = z.string().min(1).max(MAX_TRANSCRIPT_CHARS + 1024)
const urlSchema = z.string().min(1).max(2048)

/**
 * The transcript the renderer hands back for brief generation. It came FROM us,
 * but it round-tripped through the renderer, so it is re-validated as untrusted.
 */
const transcriptSchema = z.object({
  source: z.enum(['paste', 'share']),
  title: z.string().max(500).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['human', 'assistant', 'unknown']),
        text: z.string(),
        codeBlocks: z.array(z.object({ lang: z.string().max(50), code: z.string() })).max(2000),
      }),
    )
    .max(20000),
  messageCount: z.number().int().nonnegative(),
  codeBlockCount: z.number().int().nonnegative(),
  charCount: z.number().int().nonnegative(),
  roleMarkersDetected: z.boolean(),
  truncated: z.boolean(),
})

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

  ipcMain.handle(IPC.DESKTOP_IMPORT_FROM_SHARE, async (_e, url: unknown) => {
    try {
      return { ok: true, transcript: await importFromShareLink(urlSchema.parse(url)) }
    } catch (err) {
      return fail('fromShare', err)
    }
  })

  ipcMain.handle(IPC.DESKTOP_IMPORT_BUILD_BRIEF, async (_e, args: unknown) => {
    try {
      const { transcript } = z.object({ transcript: transcriptSchema }).parse(args)
      return { ok: true, brief: await generateBrief(transcript as ParsedTranscript) }
    } catch (err) {
      return fail('buildBrief', err)
    }
  })

  ipcMain.handle(IPC.DESKTOP_IMPORT_WRITE_BRIEF, async (_e, args: unknown) => {
    try {
      const { workingDirectory, markdown } = z
        .object({
          workingDirectory: z.string().min(1).max(4096),
          markdown: z.string().min(1).max(4_000_000),
        })
        .parse(args)
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
