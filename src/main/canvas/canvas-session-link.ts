// Canvas ↔ session lifecycle glue: continuity across CCC session identities.
//
// A canvas is keyed to the CCC session id (spec D2), but that id is more
// ephemeral than the work it anchors: quit the app, open a fresh tile in the
// same project, resume the same Claude conversation — new session id, and the
// canvas (plus its reviews) strands under the old one. Observed on the test VM
// 2026-08-13: same conversation, same cwd, two canvases both "v1", and the
// user typing "repush to canvas".
//
// Wired at spawn time (pty-handlers), this module:
//   - remembers each session's cwd + resume target, and exposes them to the
//     canvas store as the session-info resolver, so every canvas record is
//     stamped with the WORK's durable identities (project dir, conversation);
//   - runs adoption: a session that owns no canvas claims the most recent
//     orphaned one for the same conversation (strongest) or cwd, then re-binds
//     that canvas's review store to match.
//
// "Orphaned" is strict, and the check fails safe: a session with a live PTY or
// one still present in the saved-tile list is CURRENT — its canvas stays
// reclaimable by id, and boot-time restore order can never lose it to a
// faster-spawning sibling.

import * as path from 'path'
import { adoptCanvasForSession, setCanvasSessionInfoResolver } from './canvas-store'
import { rebindReviewsToSession } from './canvas-review-store'
import { getSessionMeta } from '../session-registry'
import { getTranscriptBinder } from '../logging/logging-service'
import { loadSessionState } from '../session-state'
import { logInfo } from '../debug-logger'

/** Transcript basenames are the conversation's uuid; matching key only. */
const CONVERSATION_UUID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/

const spawnInfo = new Map<string, { cwd?: string; resumeUuid?: string }>()

/** The conversation currently driving a session: the transcript the binder has
 *  bound (live truth, follows in-session /resume switches), else the resume
 *  target the session was spawned with. */
function conversationUuidFor(sessionId: string): string | undefined {
  try {
    const transcript = getTranscriptBinder()?.getLatestTranscriptPath(sessionId)
    if (transcript) {
      const base = path.basename(transcript).replace(/\.jsonl$/i, '')
      if (CONVERSATION_UUID_RE.test(base)) return base
    }
  } catch {
    /* binder unavailable — fall through to the spawn-time resume target */
  }
  const resume = spawnInfo.get(sessionId)?.resumeUuid
  return resume && CONVERSATION_UUID_RE.test(resume) ? resume : undefined
}

/** Arm the canvas store's session-info resolver. Idempotent; called once from
 *  canvas handler registration. */
export function installCanvasSessionLink(): void {
  setCanvasSessionInfoResolver((sessionId) => ({
    cwd: spawnInfo.get(sessionId)?.cwd,
    conversationUuid: conversationUuidFor(sessionId),
  }))
}

/**
 * Record a LOCAL session's spawn and give it its canvas back if it has one to
 * inherit. Called from the pty:spawn handler for non-SSH sessions, before the
 * PTY itself spawns — adoption is cheap (one saved-state read, in-memory
 * matching) and must precede the first render or pane open.
 */
export function noteSessionSpawnForCanvas(
  sessionId: string,
  opts: { cwd?: string; resumeUuid?: string },
): void {
  spawnInfo.set(sessionId, { cwd: opts.cwd, resumeUuid: opts.resumeUuid })

  // The saved-tile list, read once per spawn. A read failure means "cannot
  // tell who is current", and adoption declines rather than guesses.
  let savedIds: Set<string> | null = null
  try {
    const saved = loadSessionState()
    savedIds = new Set(
      (saved?.sessions ?? []).map((s) => (s as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string'),
    )
  } catch {
    savedIds = null
  }

  try {
    const adopted = adoptCanvasForSession(sessionId, {
      cwd: opts.cwd,
      conversationUuid: opts.resumeUuid,
      isSessionCurrent: (sid) => {
        if (getSessionMeta(sid)) return true // live PTY this run
        if (!savedIds) return true // unknown → untouchable
        return savedIds.has(sid) // saved tile → reclaims by id on restore
      },
    })
    if (adopted) {
      rebindReviewsToSession(adopted.canvasId, sessionId)
      logInfo(
        `[canvas] session ${sessionId} adopted canvas ${adopted.canvasId}` +
          ` (active ${adopted.activeVersionId ?? 'none'}, via ${opts.resumeUuid ? 'resume/cwd' : 'cwd'})`,
      )
    }
  } catch (err) {
    // Adoption is a convenience, never a spawn blocker.
    console.warn('[canvas] adoption failed:', err)
  }
}

/** Test seam. */
export function _resetCanvasSessionLinkForTest(): void {
  spawnInfo.clear()
}
