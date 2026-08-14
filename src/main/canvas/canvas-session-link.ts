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
import {
  adoptCanvasForSession,
  listOrphanCandidateCanvases,
  setCanvasSessionInfoResolver,
  type ReclaimableCanvas,
} from './canvas-store'
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

/**
 * Record a LOCAL session's spawn. Registers the identity used to LABEL a
 * canvas; it does not move ownership of anything (see below).
 */
export function noteSessionSpawnForCanvas(
  sessionId: string,
  opts: { cwd?: string; resumeUuid?: string; profileId?: string },
): void {
  spawnInfo.set(sessionId, { cwd: opts.cwd, resumeUuid: opts.resumeUuid, profileId: opts.profileId })
}

/**
 * Canvases this session could reclaim, for the user to choose from.
 *
 * WHY THIS IS A LIST AND NOT AN AUTOMATIC MOVE — the finding that killed two
 * rounds of fixes. A canvas carries the user's private review notes, so moving
 * one between sessions is an authorization decision, and the main process has
 * nothing trustworthy to authorize it WITH:
 *
 *   - the project directory is ambiguous (two tiles on one repo is ordinary
 *     usage, and the second would inherit the first's notes);
 *   - the conversation uuid comes from the transcript binder, which is a
 *     heuristic when the exact sources have not bound, and is writable by the
 *     agent through more than one route — round 2 demonstrated three;
 *   - "is the owner still current" has no reliable oracle either: the
 *     saved-tile file is empty for almost all of an app run, so a tile whose
 *     PTY merely exited looks abandoned.
 *
 * Every automatic rule built on those was a canvas-theft primitive. The user,
 * however, knows exactly which work is theirs — so they pick, from a list that
 * says what each canvas is. That is one click, and it cannot be forged.
 *
 * The cwd is used here only to ORDER and LABEL candidates, never to authorize:
 * a wrong guess costs a less relevant list entry, not someone's notes.
 */
export function listReclaimableCanvases(sessionId: string): ReclaimableCanvas[] {
  const info = spawnInfo.get(sessionId)
  const savedIds = savedTileIds()
  const ownCwd = info?.cwd
  return listOrphanCandidateCanvases(sessionId, {
    profileId: info?.profileId,
    isSessionCurrent: (sid) => {
      if (getSessionMeta(sid)) return true // live PTY this run
      if (!savedIds) return true // cannot tell → not offered
      return savedIds.has(sid)
    },
  })
    .map((c) => ({ ...c, sameProject: !!ownCwd && !!c.cwd && c.cwd === ownCwd }))
    .sort((a, b) => {
      if (a.sameProject !== b.sameProject) return a.sameProject ? -1 : 1
      return b.lastRenderedAt.localeCompare(a.lastRenderedAt)
    })
}

/**
 * Move a canvas to this session because the USER asked for it, by id, from the
 * list above. This is the only path that transfers ownership.
 */
export function reclaimCanvasForSession(sessionId: string, canvasId: string): boolean {
  const info = spawnInfo.get(sessionId)
  const savedIds = savedTileIds()
  const adopted = adoptCanvasForSession(sessionId, canvasId, {
    profileId: info?.profileId,
    isSessionCurrent: (sid) => {
      if (getSessionMeta(sid)) return true
      if (!savedIds) return true
      return savedIds.has(sid)
    },
  })
  if (!adopted) return false
  rebindReviewsToSession(adopted.canvasId, sessionId)
  logInfo(
    `[canvas] session ${sessionId} reclaimed canvas ${adopted.canvasId} at the user's request` +
      ` (active ${adopted.activeVersionId ?? 'none'})`,
  )
  return true
}

/** Drop a session's link state when its PTY is gone for good. */
export function forgetSessionForCanvas(sessionId: string): void {
  spawnInfo.delete(sessionId)
}

/** Test seam. */
export function _resetCanvasSessionLinkForTest(): void {
  spawnInfo.clear()
}
