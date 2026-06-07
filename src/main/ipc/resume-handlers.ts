/**
 * resume-handlers.ts — the exact-conversation resume target IPC (bug #5, T8b).
 *
 * Moved here from the now-deleted logsdb-handlers.ts (Logs v2 deletion sweep,
 * T18). Behaviour is IDENTICAL: resolve a session's exact-conversation resume
 * target ({uuid,cwd}) from the latest bound transcript, or null. Fully fail-safe
 * (any miss => null) so the renderer's save-time enrichment simply omits the
 * field. Reaches the transcript binder via logging-service (never imports a DB).
 *
 * No default export (project convention).
 */
import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import { getTranscriptBinder } from '../logging/logging-service'
import { resolveResumeTargetFromTranscript } from '../logging/transcript-discovery'

const sessionIdSchema = z.string().min(1).max(200)

export function registerResumeHandlers(): void {
  // T8b (bug #5): resolve a session's exact-conversation resume target from the
  // latest bound transcript. Returns {uuid,cwd} or null. Fully fail-safe (any
  // miss => null) so the renderer's save-time enrichment simply omits the field.
  ipcMain.handle(IPC.LOGS_GET_RESUME_TARGET, async (_e, sessionId: string) => {
    try {
      sessionIdSchema.parse(sessionId)
      const latest = getTranscriptBinder()?.getLatestTranscriptPath(sessionId)
      if (!latest) return null
      return resolveResumeTargetFromTranscript(latest)
    } catch {
      return null
    }
  })
}
