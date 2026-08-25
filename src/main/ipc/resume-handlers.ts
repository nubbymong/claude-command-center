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
import { getTranscriptBinder, getLogSupervisor } from '../logging/logging-service'
import { resolveResumeTargetFromTranscript } from '../logging/transcript-discovery'

const sessionIdSchema = z.string().min(1).max(200)

export function registerResumeHandlers(): void {
  // T8b (bug #5) + #480: resolve a session's exact-conversation resume target.
  // Source of truth is the durable session_conversation map (survives restart /
  // crash), written on every authenticated EXACT bind; the live EXACT bind is the
  // fallback. A heuristic (newest-file) guess is NEVER used — that folder scan is
  // what resumed a sibling card's conversation for same-repo sessions. Returns
  // {uuid,cwd} or null; fully fail-safe (any miss => null) so the renderer's
  // save-time enrichment simply omits the field.
  ipcMain.handle(IPC.LOGS_GET_RESUME_TARGET, async (_e, sessionId: string) => {
    try {
      sessionIdSchema.parse(sessionId)
      let path: string | null = null
      // Prefer the durable record.
      try {
        const rows = await getLogSupervisor()?.query('session-conversation', { sessionId })
        const row = rows?.[0] as { path?: string } | undefined
        if (row?.path) path = row.path
      } catch {
        /* durable lookup is best-effort; fall through to the live exact bind */
      }
      // Fall back to the live EXACT bind (never getLatestTranscriptPath, which
      // also returns heuristic binds).
      if (!path) path = getTranscriptBinder()?.getExactResumeTarget(sessionId) ?? null
      if (!path) return null
      return resolveResumeTargetFromTranscript(path)
    } catch {
      return null
    }
  })
}
