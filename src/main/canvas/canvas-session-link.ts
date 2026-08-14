// Canvas ↔ session lifecycle glue: continuity across CCC session identities.
//
// A canvas is keyed to the CCC session id (spec D2), but that id is more
// ephemeral than the work it anchors: quit the app, open a fresh tile, resume
// the same Claude conversation — new session id, and the canvas (plus its
// reviews) strands under the old one. Observed on the test VM 2026-08-13: same
// conversation, two canvases both "v1", and the user typing "repush to canvas".
//
// This module resolves each session's identity for the canvas store (so every
// record is stamped with the conversation and account it belongs to) and runs
// ADOPTION: a session with no canvas reclaims the canvas of the same
// conversation. Adoption is keyed on the CONVERSATION, never the project
// directory — see the long note on adoptCanvasForSession for why a directory
// match was a canvas-theft primitive (adversarial review, 2026-08-14).
//
// "Orphaned" is strict and fails safe: a session with a live PTY, or one still
// listed in a saved-tile file we could actually read, is CURRENT — its canvas
// stays reclaimable by id, and boot-time restore order can never lose it to a
// faster-spawning sibling.

import * as path from 'path'
import { adoptCanvasForSession, getCanvasStateForSession, setCanvasSessionInfoResolver } from './canvas-store'
import { rebindReviewsToSession } from './canvas-review-store'
import { getSessionMeta } from '../session-registry'
import { getTranscriptBinder } from '../logging/logging-service'
import { hasSavedSessionState, loadSessionState } from '../session-state'
import { logInfo } from '../debug-logger'

/** Transcript basenames are the conversation's uuid; matching key only. */
const CONVERSATION_UUID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/

interface SpawnInfo {
  cwd?: string
  resumeUuid?: string
  profileId?: string
  /** Cleared once this session owns a canvas, so the retry stops running. */
  settled?: boolean
}

const spawnInfo = new Map<string, SpawnInfo>()

/** The conversation currently driving a session: the transcript the binder has
 *  bound (live truth — it follows an in-session `/resume` and is the ONLY
 *  source when the user resumed inside Claude rather than through a CCC tile),
 *  else the resume target the session was spawned with. */
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
    profileId: spawnInfo.get(sessionId)?.profileId,
  }))
}

/**
 * Who counts as still able to reclaim their canvas by id.
 *
 * The saved-tile half has to distinguish three states, and the first cut did
 * not: `loadSessionState()` never throws (it catches everything and returns
 * null), so the `catch` that was supposed to mean "cannot tell → untouchable"
 * was unreachable — and because the state file only exists between a graceful
 * "Save & Close" and the next restore, the common runtime answer was an EMPTY
 * set, i.e. "nobody is current" (adversarial review, 2026-08-14: a guard no
 * input can trip). Now: a file that exists but does not load means UNKNOWN and
 * everything is untouchable; no file at all means there are genuinely no saved
 * tiles, which is a real answer.
 */
function savedTileIds(): Set<string> | null {
  try {
    const saved = loadSessionState()
    if (saved && Array.isArray(saved.sessions)) {
      return new Set(
        saved.sessions.map((s) => (s as { id?: unknown })?.id).filter((id): id is string => typeof id === 'string'),
      )
    }
    // Did not load. If the file is THERE, we cannot tell who was open.
    return hasSavedSessionState() ? null : new Set()
  } catch {
    return null
  }
}

function tryAdopt(sessionId: string, info: SpawnInfo): void {
  const conversationUuid = conversationUuidFor(sessionId)
  if (!conversationUuid) return // nothing identifies this work yet

  const savedIds = savedTileIds()
  const adopted = adoptCanvasForSession(sessionId, {
    conversationUuid,
    profileId: info.profileId,
    isSessionCurrent: (sid) => {
      if (getSessionMeta(sid)) return true // live PTY this run
      if (!savedIds) return true // cannot tell → untouchable
      return savedIds.has(sid) // saved tile → reclaims by id on restore
    },
  })
  if (adopted) {
    info.settled = true
    rebindReviewsToSession(adopted.canvasId, sessionId)
    logInfo(
      `[canvas] session ${sessionId} adopted canvas ${adopted.canvasId}` +
        ` (active ${adopted.activeVersionId ?? 'none'}, conversation ${conversationUuid})`,
    )
  }
}

/**
 * Record a LOCAL session's spawn and give it its canvas back if it has one to
 * reclaim. Called from the pty:spawn handler for non-SSH sessions.
 */
export function noteSessionSpawnForCanvas(
  sessionId: string,
  opts: { cwd?: string; resumeUuid?: string; profileId?: string },
): void {
  const info: SpawnInfo = { cwd: opts.cwd, resumeUuid: opts.resumeUuid, profileId: opts.profileId }
  spawnInfo.set(sessionId, info)
  try {
    tryAdopt(sessionId, info)
  } catch (err) {
    // Adoption is a convenience, never a spawn blocker.
    console.warn('[canvas] adoption failed:', err)
  }
}

/**
 * Re-attempt adoption for a session that still owns no canvas.
 *
 * Spawn is too early for the common case: when the user resumes a conversation
 * from INSIDE Claude (rather than through a CCC tile restore), there is no
 * spawn-time resume uuid and the transcript binder only learns the
 * conversation seconds later. Without this the session would render a fresh
 * "v1" onto a brand-new canvas — the exact bug this feature exists to fix. So
 * the two moments that actually need the canvas call here first: the renderer
 * asking for canvas state (pane open / refresh) and the agent rendering.
 *
 * Cheap and idempotent: one map lookup once a session has settled.
 */
export function ensureCanvasAdopted(sessionId: string): void {
  const info = spawnInfo.get(sessionId)
  if (!info || info.settled) return
  // Already owns one (rendered its own, or adopted earlier) — nothing to do.
  if (getCanvasStateForSession(sessionId)) {
    info.settled = true
    return
  }
  try {
    tryAdopt(sessionId, info)
  } catch (err) {
    console.warn('[canvas] adoption retry failed:', err)
  }
}

/** Drop a session's link state when its PTY is gone for good. */
export function forgetSessionForCanvas(sessionId: string): void {
  spawnInfo.delete(sessionId)
}

/** Test seam. */
export function _resetCanvasSessionLinkForTest(): void {
  spawnInfo.clear()
}
