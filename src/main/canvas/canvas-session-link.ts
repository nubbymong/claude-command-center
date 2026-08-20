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
 * How many candidates the pane is ever offered.
 *
 * A reclaim card the user has to read is a card they can mis-click, and the
 * list is uncapped input to a component that renders every entry. The most
 * relevant survive (the sort runs first), which is what a user scanning for
 * their own work would have looked at anyway.
 */
const MAX_RECLAIM_CANDIDATES = 12

/** Bound on the open-tile hint below. It can only ever REMOVE candidates, so
 *  the cap is about work done, not about trust. */
const MAX_OPEN_TILE_HINTS = 256

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
 *
 * `openTileSessionIds` — THE MISSING ORACLE (adversarial review, 2026-08-15).
 * The two existing "is the owner still current" tests answer for a session with
 * a live PTY and for one in the saved-tile file; between them sits the ordinary
 * case they both miss — a tile the user has OPEN whose PTY has exited (`/exit`,
 * a crash, the Restart button) during a run in which no state file exists. Such
 * a canvas was offered to a new session as "an earlier session" while its own
 * tile sat on screen showing it. Only the renderer knows which tiles are open,
 * so it says. This input can only ADD sessions to the current set — a missing
 * or wrong id falls through to the checks that were already there — so it
 * tightens the answer and can never widen it, which is why a renderer-supplied
 * hint is admissible here at all.
 */
/** The "can this session still come back for its canvas" test, built ONCE so
 *  the lister and the reclaim can never disagree — a list that refuses while
 *  the by-id reclaim allows is the hole, not the fix. */
function currentSessionOracle(openTileSessionIds: string[]): (sid: string) => boolean {
  const savedIds = savedTileIds()
  const openIds = new Set(
    (Array.isArray(openTileSessionIds) ? openTileSessionIds : [])
      .slice(0, MAX_OPEN_TILE_HINTS)
      .filter((id): id is string => typeof id === 'string'),
  )
  return (sid) => {
    if (getSessionMeta(sid)) return true // live PTY this run
    if (openIds.has(sid)) return true // tile still on screen, PTY or not
    if (!savedIds) return true // cannot tell → not offered
    return savedIds.has(sid)
  }
}

export function listReclaimableCanvases(sessionId: string, openTileSessionIds: string[] = []): ReclaimableCanvas[] {
  const info = spawnInfo.get(sessionId)
  const ownCwd = info?.cwd
  return listOrphanCandidateCanvases(sessionId, {
    profileId: info?.profileId,
    isSessionCurrent: currentSessionOracle(openTileSessionIds),
  })
    .map((c) => ({ ...c, sameProject: !!ownCwd && !!c.cwd && c.cwd === ownCwd }))
    .sort((a, b) => {
      if (a.sameProject !== b.sameProject) return a.sameProject ? -1 : 1
      return b.lastRenderedAt.localeCompare(a.lastRenderedAt)
    })
    .slice(0, MAX_RECLAIM_CANDIDATES)
}

/**
 * Move a canvas to this session because the USER asked for it, by id, from the
 * list above. This is the only path that transfers ownership.
 */
export function reclaimCanvasForSession(
  sessionId: string,
  canvasId: string,
  openTileSessionIds: string[] = [],
): boolean {
  const info = spawnInfo.get(sessionId)
  const adopted = adoptCanvasForSession(sessionId, canvasId, {
    profileId: info?.profileId,
    // The SAME oracle the list used. Reclaim is addressed by id, so a canvas
    // the list correctly refused to offer must not be takeable by naming it.
    isSessionCurrent: currentSessionOracle(openTileSessionIds),
  })
  if (!adopted) return false
  rebindReviewsToSession(adopted.canvasId, sessionId)
  logInfo(
    `[canvas] session ${sessionId} reclaimed canvas ${adopted.canvasId} at the user's request` +
      ` (active ${adopted.activeVersionId ?? 'none'})`,
  )
  return true
}

/**
 * The project directory a session was spawned in, or undefined if we never saw
 * it spawn (a session restored from a previous run, for example).
 *
 * Used to scope the canvas LIBRARY to the project you are in. Note this is a
 * relevance filter and nothing more — the cwd is not an authorization key here
 * any more than it is in `listReclaimableCanvases`, and a session we have no
 * cwd for is shown everything rather than nothing.
 */
export function canvasCwdForSession(sessionId: string): string | undefined {
  return spawnInfo.get(sessionId)?.cwd
}

/**
 * The account a session was spawned under, or undefined for the default account
 * (and for a session we never saw spawn).
 *
 * Unlike the cwd above, this one IS part of an authorization key: it is what
 * `adoptCanvasForSession` compares against the record's stamp. The library takes
 * it so a row badged "yours" is a row the action will actually open — resolved
 * in main from its own spawn record, never accepted from the renderer.
 */
export function canvasProfileForSession(sessionId: string): string | undefined {
  return spawnInfo.get(sessionId)?.profileId
}

/** Drop a session's link state when its PTY is gone for good. */
export function forgetSessionForCanvas(sessionId: string): void {
  spawnInfo.delete(sessionId)
}

/** Test seam. */
export function _resetCanvasSessionLinkForTest(): void {
  spawnInfo.clear()
}
