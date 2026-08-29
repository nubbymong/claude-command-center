// Canvas ↔ session lifecycle glue: THE OWNERSHIP LEASE.
//
// A canvas is keyed to the CCC session id (spec D2), but that id is more
// ephemeral than the work it anchors: quit the app, open a fresh tile, resume
// the same Claude conversation — new session id, and the canvas (plus its
// reviews) strands under the old one. Observed on the test VM 2026-08-13: same
// conversation, two canvases both "v1", and the user typing "repush to canvas".
//
// THE LEASE IS LIVENESS, NOT A STORED FIELD (M4). A canvas in flight belongs to
// the session that rendered it for exactly as long as that session is LIVE, and
// while it does it is PRIVATE to that session: no other live session sees a
// Library row, a front-page row, a review action or a count for it. When the
// owner stops being live — the app quit, the tile closed, the PTY exited — the
// canvas is OWNERLESS IN FLIGHT. Not gone, not memorialised: resumable.
//
// RESUME IS EXPLICIT, ATOMIC AND FIRST-WINS. Nothing auto-attaches, ever. Two
// rounds of adversarial review (2026-08-14/15) established that no identity the
// main process can infer is trustworthy enough to move the user's private
// review notes on its own — the project directory is ambiguous (two tiles on
// one repo), the conversation uuid is heuristic and agent-writable, and "is the
// owner still around" had no oracle at all. That finding stands. What M4 adds
// is the compare-and-set: the user picks a row, and the row carries the owner
// they SAW, so a resume that would land on a different owner is refused rather
// than taking a canvas somebody else has already picked up.
//
// This module owns the LIVENESS ORACLE and the spawn record; the store owns the
// records and performs the transfer (canvas-store.resumeCanvasForSession).

import * as path from 'path'
import {
  canvasOwnershipOf,
  deleteCanvas,
  listResumableCanvases,
  openOwnCanvasForSession,
  resumeCanvasForSession,
  sameProjectDir,
  sameProjectDirExactCase,
  setCanvasSessionInfoResolver,
  type CanvasWorkspaceCheck,
} from './canvas-store'
import { dropReviewsForCanvas, getReviewCountsForCanvas, rebindReviewsToSession } from './canvas-review-store'
import { isPtySessionLive } from '../session-registry'
import { getTranscriptBinder } from '../logging/logging-service'
import { listProfiles } from '../account-profiles'
import { logInfo } from '../debug-logger'
import {
  CANVAS_CONFIG_ID_RE,
  sanitizeAuditLabel,
  type AuditStamp,
  type CanvasDismissResult,
  type CanvasResumeResult,
  type ResumableRow,
} from '../../shared/canvas'

/** Transcript basenames are the conversation's uuid; matching key only. */
const CONVERSATION_UUID_RE = /^[0-9a-fA-F][0-9a-fA-F-]{7,63}$/

interface SpawnInfo {
  cwd?: string
  resumeUuid?: string
  /** The CONFIG this session runs, by its display name (M3).
   *
   *  A pure LABEL, and it exists for two surfaces: the generated name of a test
   *  pack ("Checkout flow · build 5 · 29 Aug"), and the audit line's session
   *  column. The renderer sends `customName || label || 'default'`, so it is
   *  really the TILE's own name — which is why it becomes `sessionLabel` on an
   *  audit stamp rather than the config name (that is resolved from `configId`
   *  at read, so a rename follows). Recorded at spawn exactly like `cwd` — and,
   *  exactly like `cwd`, it authorizes nothing and a session we never saw spawn
   *  simply has none. */
  configLabel?: string
  /** The CONFIG this session runs, by its STABLE id (M4).
   *
   *  Stamped onto the canvas record at creation so the Library can resolve the
   *  config's CURRENT display name at read time. A lookup key into the user's
   *  own configs.json and nothing else: never a serving key, never an
   *  authorization key. */
  configId?: string
  /** The ACCOUNT this session runs, by its profile DISPLAY NAME (M4).
   *
   *  Resolved once at spawn from the profile id the renderer launched with.
   *  Display metadata only, and deliberately never the email: the audit line is
   *  read by whoever opens the project Library, and "Personal · work" is what
   *  tells two rows apart without putting an address on screen. A
   *  single-account (no profile) session has none — see the note on
   *  `accountDisplayNameFor`. */
  account?: string
}

const spawnInfo = new Map<string, SpawnInfo>()

/**
 * The account's DISPLAY NAME for a session, or undefined.
 *
 * Main does hold a per-session account identity — `claude-account-identity`
 * captures the profile id and the email at spawn — but the only DISPLAY-NAME
 * form of it is `AccountProfile.name` ("Personal · nick", user-renameable),
 * which exists only for a multi-account (profile) session. A single-account
 * session has just the email from the GLOBAL `~/.claude.json`, and that is not
 * a per-session name: putting it on an audit line would be inventing a global
 * identity for every row, which is exactly what ADR-017 removed. So those
 * sessions stamp nothing, and `account` is absent — which every reader already
 * handles, because absent means unknown everywhere in this contract.
 *
 * Never fatal: an unreadable profiles.json costs a label, not a spawn.
 */
function accountDisplayNameFor(profileId: string | undefined): string | undefined {
  if (!profileId) return undefined
  try {
    return sanitizeAuditLabel(listProfiles().find((p) => p.id === profileId)?.name)
  } catch {
    return undefined
  }
}

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

/** The display half of a session's spawn record, as an audit stamp's labels.
 *  `at` is minted by whoever writes the stamp — main's own clock, never a
 *  caller's — so this carries the labels and nothing else. */
function auditLabelsFor(sessionId: string): Pick<AuditStamp, 'sessionLabel' | 'account'> {
  const info = spawnInfo.get(sessionId)
  const sessionLabel = sanitizeAuditLabel(info?.configLabel === 'default' ? undefined : info?.configLabel)
  const account = sanitizeAuditLabel(info?.account)
  return {
    ...(sessionLabel ? { sessionLabel } : {}),
    ...(account ? { account } : {}),
  }
}

/** Arm the canvas store's session-info resolver. Idempotent; called once from
 *  canvas handler registration. */
export function installCanvasSessionLink(): void {
  setCanvasSessionInfoResolver((sessionId) => {
    const info = spawnInfo.get(sessionId)
    return {
      cwd: info?.cwd,
      conversationUuid: conversationUuidFor(sessionId),
      ...(info?.configId ? { configId: info.configId } : {}),
      // Labels only: the store mints the moment from its own clock.
      auditLabels: auditLabelsFor(sessionId),
    }
  })
}

/**
 * Record a LOCAL session's spawn. Registers the identity used to LABEL a
 * canvas; it does not move ownership of anything.
 */
export function noteSessionSpawnForCanvas(
  sessionId: string,
  opts: { cwd?: string; resumeUuid?: string; configLabel?: string; configId?: string; profileId?: string },
): void {
  // The config id is pinned to its shape HERE rather than trusted onward: it is
  // stamped onto a durable record and later used as a lookup key into the
  // user's own configs.json, so a value that is not a config id has no business
  // being recorded even though nothing serves from it.
  const configId =
    typeof opts.configId === 'string' && CANVAS_CONFIG_ID_RE.test(opts.configId) ? opts.configId : undefined
  spawnInfo.set(sessionId, {
    cwd: opts.cwd,
    resumeUuid: opts.resumeUuid,
    configLabel: opts.configLabel,
    ...(configId ? { configId } : {}),
    ...(accountDisplayNameFor(opts.profileId) ? { account: accountDisplayNameFor(opts.profileId) } : {}),
  })
}

/** Bound on the open-tile hint below. It can only ever ADD live sessions — and
 *  live means untouchable — so the cap is about work done, not about trust. */
const MAX_OPEN_TILE_HINTS = 256

/**
 * IS THIS SESSION LIVE? — THE SECURITY GATE, AND IT READS ONE SIGNAL.
 *
 * `isPtySessionLive` is a set in `session-registry` written by exactly two
 * lines of `pty-manager`: add on spawn, remove on cleanup. A fact about this
 * process that no caller can shape, and — the part that took a second round to
 * get right — a fact about the PTY's LIFETIME rather than about session
 * metadata.
 *
 * ROUND 2. This first read `getSessionMeta`, which looked equivalent and was
 * not: that map is shared metadata with a second writer,
 * `github-handlers.bindGitHubMeta`, which patches `{ id, repo, branch }` for
 * every saved session with a GitHub integration at handler-registration — no
 * PTY, no spawn. An id that had never run therefore read LIVE for the rest of
 * the run, and its canvas was stranded three ways: un-resumable,
 * un-dismissable, and invisible in the Library (the same oracle scopes the
 * privacy rule). "Unforgeable" was true of it; "about a PTY" was not, and the
 * lease needs both.
 *
 * THE SPLIT, AND WHY IT EXISTS (adversarial review). This used to OR in
 * `openTileSessionIds`, the renderer's list of tiles on screen — a per-call
 * array that the CALLING session composes. It reached three destructive
 * decisions: whether a peer may resume another session's canvas, whether it may
 * dismiss or delete it, and whether it may see it at all. A same-project peer
 * needed no forgery to defeat it, only to leave the owner out of a request it
 * writes itself. A protection that the attacker opts into is not one.
 *
 * The argument that admitted the hint — "it can only ADD sessions to the live
 * set, so it tightens and never widens" — was sound while the set only
 * WITHHELD rows from a read-only list. It stopped being sound the moment the
 * same set decided who may destroy somebody else's work, because the caller
 * chooses what to add.
 *
 * So the model is stated plainly and the code matches it:
 *   - PTY-ALIVE  = protected, unforgeably;
 *   - PTY-DEAD   = OWNERLESS by the M4 lease = resumable and dismissable.
 * The hint survives as a DISPLAY filter only (see `listResumableRows`): do not
 * OFFER a resume row for a corpse tile the user can still see on their own
 * screen. It permits nothing, and it protects nothing.
 *
 * THE SAVED-TILE FILE IS DELIBERATELY GONE TOO (M4). It answered a different
 * question — "did this session exist when the app was last closed" — and a
 * closed app's tiles cannot review anything, so treating them as live left
 * every canvas from a graceful Save & Close untouchable for ever, which is the
 * exact stranding the resume path exists to end.
 */
export function isSessionLive(sessionId: string): boolean {
  return isPtySessionLive(sessionId)
}

/** The open-tile hint, bounded and shape-checked once per call. */
function openTileSet(openTileSessionIds: readonly string[] | undefined): Set<string> {
  return new Set(
    (Array.isArray(openTileSessionIds) ? openTileSessionIds : [])
      .slice(0, MAX_OPEN_TILE_HINTS)
      .filter((id): id is string => typeof id === 'string'),
  )
}

/**
 * The liveness oracle the store's guards take — one object, so the lister, the
 * resume and the delete guard can never disagree. A list that refuses while the
 * by-id action allows is the hole, not the fix.
 *
 * Takes NO hint, deliberately: see `isSessionLive`.
 */
export function canvasLivenessQuery(): { isSessionLive: (sessionId: string) => boolean } {
  return { isSessionLive }
}

/**
 * SAME PROJECT AND SAME CONFIG — the second factor on every destructive
 * cross-session action (dismiss, whole-canvas delete, resume).
 *
 * WHY A SECOND FACTOR. `sameProjectDir` decides case-sensitivity from
 * `process.platform`, so on Windows and macOS it folds case for the whole
 * machine. Both platforms can carry case-SENSITIVE volumes — an NTFS directory
 * with the per-directory flag set, an APFS case-sensitive volume — on which
 * `…\Foo` and `…\foo` are two genuinely different projects that this compares
 * equal. A peer sitting in `foo` could then dismiss or resume a victim's canvas
 * rooted at `Foo`, and choosing where to sit is not an attack that needs any
 * privilege.
 *
 * WHERE THE CALLER'S configId COMES FROM, since that decides whether it is worth
 * anything: main's own spawn record (`noteSessionSpawnForCanvas`, called only
 * from `pty:spawn`), captured once when the user launched the tile. It is not a
 * per-call IPC argument, so nothing reachable from a canvas channel — and in
 * particular nothing an agent can drive — chooses it. Same standing as `cwd`.
 *
 * TWO SHAPES, because the second factor is only available on the newer rows:
 *
 *   - BOTH configIds known: they must be equal, and the project may then be
 *     compared the way the filesystem would.
 *   - EITHER missing — every pre-M4 canvas, and every session not launched from
 *     a named saved config, i.e. the common and legacy case — the project must
 *     match EXACTLY, case included. Round 1 fell back to the case-folded
 *     compare here, which left the whole case-fold hole open for precisely the
 *     rows most likely to hit it.
 *
 * THE RESIDUALS, STATED:
 *   - with both configIds known, a case-only-different pair of real projects
 *     whose sessions ALSO run the same config still matches. Both factors have
 *     to collide, which a peer cannot arrange by choosing a directory name;
 *   - the exact-case fallback is STRICTER than a case-insensitive filesystem,
 *     so an honest peer whose recorded cwd differs from the record's only by
 *     case is refused a dismiss/resume. The cost is one refusal on a
 *     destructive action — their own work is still theirs, and the canvas stays
 *     until its owner returns or they delete it from their own Library — which
 *     is the right side to fail on.
 *
 * Fails closed: a caller we have no project for, or a record that records none,
 * matches nothing.
 */
function sameWorkspace(
  mine: { cwd?: string; configId?: string },
  theirs: { cwd?: string; configId?: string },
): boolean {
  if (!mine.cwd || !theirs.cwd) return false
  if (mine.configId && theirs.configId) {
    return mine.configId === theirs.configId && sameProjectDir(mine.cwd, theirs.cwd)
  }
  return sameProjectDirExactCase(mine.cwd, theirs.cwd)
}

/** The workspace check for one caller, as the store's guards take it. */
function workspaceCheckFor(sessionId: string): CanvasWorkspaceCheck {
  const info = spawnInfo.get(sessionId)
  const mine = { ...(info?.cwd ? { cwd: info.cwd } : {}), ...(info?.configId ? { configId: info.configId } : {}) }
  return (theirs) => sameWorkspace(mine, theirs)
}

/** How many LIVE notes plus unsent drafts a canvas is carrying — the "N notes"
 *  a resume row shows. An unreadable review store costs the number, never the
 *  row: 0 here means "nothing to report", and the row still lists. */
function liveNoteCount(canvasId: string): number {
  const counts = getReviewCountsForCanvas(canvasId)
  if (!counts) return 0
  return counts.openNotes + counts.addressedNotes + counts.draftNotes
}

/**
 * OWNERLESS IN-FLIGHT canvases this session could resume. Pure read.
 *
 * Scoped to the caller's PROJECT (relevance, never authorization — a canvas
 * with no recorded project, or a caller we have no project for, is still
 * offered), ordered with the caller's own config first and newest work above
 * older.
 *
 * `configNameOf` comes from the IPC handler, which is the layer that may read
 * config-manager. Passing it down rather than returning the raw id keeps the
 * name resolved AT READ (a renamed config renames the row) without this module
 * or the store ever holding a config id in a field named for a name.
 */
export function listResumableRows(
  sessionId: string,
  openTileSessionIds: readonly string[] = [],
  configNameOf?: (configId: string) => string | undefined,
): ResumableRow[] {
  const info = spawnInfo.get(sessionId)
  const rows = listResumableCanvases(sessionId, canvasLivenessQuery(), {
    isEligible: workspaceCheckFor(sessionId),
    ...(info?.configId ? { configId: info.configId } : {}),
    noteCountOf: liveNoteCount,
    ...(configNameOf ? { configNameOf } : {}),
  })
  // THE HINT'S ONLY REMAINING JOB, and it is cosmetic: do not OFFER to resume a
  // canvas whose tile the user can still see on their own screen. That tile's
  // PTY has exited, so the canvas IS resumable — nothing here permits or
  // forbids anything, it only declines to put a confusing row in front of
  // somebody who is looking at the thing it describes.
  const onScreen = openTileSet(openTileSessionIds)
  return rows.filter((row) => !onScreen.has(row.expectedOwnerSessionId))
}

/**
 * RESUME: move an ownerless in-flight canvas to this session, first-wins.
 *
 * The compare-and-set lives in the store and is synchronous end to end; this is
 * the place that supplies the oracle and, on success, catches reviews.json up
 * (it carries the owner session id too). The rebind runs AFTER the transfer has
 * been persisted, exactly as the old reclaim path did — a rebind of a canvas
 * that did not move would re-stamp another session's review file.
 */
export function resumeCanvasFromSession(
  sessionId: string,
  canvasId: string,
  expectedOwnerSessionId: string,
  /** Accepted for the wire's sake and NOT consulted: liveness is the PTY
   *  registry's answer alone (see `isSessionLive`), and the hint only shapes
   *  what `listResumableRows` offers. */
  _openTileSessionIds: readonly string[] = [],
): { ok: true; canvasId: string } | { ok: false; reason: NonNullable<CanvasResumeResult['reason']> } {
  const result = resumeCanvasForSession(
    sessionId,
    canvasId,
    expectedOwnerSessionId,
    canvasLivenessQuery(),
    // Same project AND same config — the same predicate the list is scoped by,
    // so a row that was never offered cannot be taken by naming its id.
    workspaceCheckFor(sessionId),
  )
  if (!result.ok) return { ok: false, reason: result.reason }
  rebindReviewsToSession(result.canvasId, sessionId)
  logInfo(
    `[canvas] session ${sessionId} resumed canvas ${result.canvasId} at the user's request` +
      ` (active ${result.activeVersionId ?? 'none'})`,
  )
  return { ok: true, canvasId: result.canvasId }
}

/**
 * OPEN HERE: point this session at a canvas it ALREADY OWNS.
 *
 * Transfers nothing, so it needs no oracle and no compare-and-set — the record
 * already says this session. A foreign canvas is refused: taking one is
 * `resumeCanvasFromSession`, and it is the only path that moves ownership.
 */
export function openOwnCanvasForSessionLink(sessionId: string, canvasId: string): boolean {
  const opened = openOwnCanvasForSession(sessionId, canvasId)
  if (!opened) return false
  logInfo(`[canvas] session ${sessionId} opened its own canvas ${opened.canvasId}`)
  return true
}

/**
 * WHO MAY MUTATE THIS CANVAS — the one guard every destructive channel is built
 * from (delete, dismiss, archive, delete-artifact).
 *
 * Three answers, in this order, and the order is the whole of it:
 *
 *   1. THE OWNER may. Always, including while it is completed — Reopen and
 *      Delete of your own memorialised work stay yours;
 *   2. a LIVE OTHER owner means NO — live meaning a PTY running in this app
 *      run, which is the one signal no caller can shape. In-flight work is
 *      private to the live session holding it, and a delete is the sharpest
 *      thing a stranger could do to it;
 *   3. a COMPLETED canvas is OWNER-ONLY. Memorialised work is shared history
 *      that non-owners get to READ; archiving or deleting somebody else's
 *      signed-off pack is not a housekeeping gesture, it is destroying their
 *      record of it.
 *
 * What is left — an OWNERLESS IN-FLIGHT canvas — is allowed to a caller in the
 * same WORKSPACE (project AND config; see `sameWorkspace`). That is the dismiss
 * case: work whose session is gone, sitting where the caller is, which somebody
 * has to be able to clear.
 *
 * Fails closed: an unknown canvas, and a caller whose workspace we cannot
 * establish against a canvas that records one, both refuse.
 */
export function canvasMutationAllowed(
  sessionId: string,
  canvasId: string,
  /** Accepted for the wire's sake and NOT consulted — see `isSessionLive`. */
  _openTileSessionIds: readonly string[] = [],
): { ok: true } | { ok: false; reason: 'owner-live' | 'not-eligible' } {
  const owner = canvasOwnershipOf(canvasId)
  if (!owner) return { ok: false, reason: 'not-eligible' }
  if (owner.sessionId === sessionId) return { ok: true }
  if (isSessionLive(owner.sessionId)) return { ok: false, reason: 'owner-live' }
  if (owner.completed) return { ok: false, reason: 'not-eligible' }
  // Ownerless and in flight: same WORKSPACE — project AND config, not the
  // project alone. See `sameWorkspace`.
  return workspaceCheckFor(sessionId)({ cwd: owner.cwd, configId: owner.configId })
    ? { ok: true }
    : { ok: false, reason: 'not-eligible' }
}

/**
 * OWNER-ONLY, the stricter sibling of `canvasMutationAllowed` — the rule for
 * ARCHIVING and DELETING one ARTEFACT.
 *
 * The difference from the dismiss/delete rule is deliberate and is the whole of
 * it: that one admits a same-project caller against an OWNERLESS canvas,
 * because somebody has to be able to clear work whose session is gone, and
 * dismiss discards the canvas WHOLE with a confirm that says so. Reaching
 * inside a canvas you do not own to archive or destroy ONE artefact of it is a
 * different act: it is silent, it is partial, and the person who made the rest
 * of that canvas gets no confirm and no trace. So it is the owner's alone,
 * whether the canvas is in flight or memorialised.
 *
 * Same closed vocabulary, so the renderer has one set of words to say.
 */
export function canvasArtifactMutationAllowed(
  sessionId: string,
  canvasId: string,
  /** Accepted for the wire's sake and NOT consulted — see `isSessionLive`. */
  _openTileSessionIds: readonly string[] = [],
): { ok: true } | { ok: false; reason: 'owner-live' | 'not-eligible' } {
  const owner = canvasOwnershipOf(canvasId)
  if (!owner) return { ok: false, reason: 'not-eligible' }
  if (owner.sessionId === sessionId) return { ok: true }
  // 'owner-live' when the owner is actually live, so the refusal says the more
  // informative of the two true things; 'not-eligible' otherwise.
  return isSessionLive(owner.sessionId) ? { ok: false, reason: 'owner-live' } : { ok: false, reason: 'not-eligible' }
}

/**
 * DISMISS: discard an in-flight canvas and everything it holds.
 *
 * A DISCARD, not an archive — the directory goes, the evidence pack with it,
 * and the confirm that fronts this says so in those words. Allowed to the
 * owner, or to a same-project caller when the canvas is ownerless; never while
 * another session is live-owner.
 *
 * The review record is dropped here rather than inside `deleteCanvas` because
 * the review store imports the canvas store — this module is one of the two
 * places that already holds both (the other is the IPC handler, for the same
 * reason).
 */
export function dismissCanvasForSession(
  sessionId: string,
  canvasId: string,
  openTileSessionIds: readonly string[] = [],
): CanvasDismissResult {
  const allowed = canvasMutationAllowed(sessionId, canvasId, openTileSessionIds)
  if (!allowed.ok) return { ok: false, reason: allowed.reason }
  const owner = canvasOwnershipOf(canvasId)
  // A memorialised canvas is not "in flight" and is not dismissed: the Library
  // deletes it, with its own confirm, and only for its owner. Reached only when
  // the caller IS the owner (the guard refuses everyone else), so this is the
  // "you cannot dismiss your own history, you delete it" branch.
  if (owner?.completed) return { ok: false, reason: 'not-eligible' }
  if (!deleteCanvas(canvasId)) return { ok: false, reason: 'not-eligible' }
  dropReviewsForCanvas(canvasId)
  logInfo(`[canvas] session ${sessionId} dismissed canvas ${canvasId} (discarded with its evidence)`)
  return { ok: true }
}

/**
 * The project directory a session was spawned in, or undefined if we never saw
 * it spawn (a session restored from a previous run, for example).
 *
 * Used to scope the canvas LIBRARY to the project you are in. Note this is a
 * relevance filter and nothing more — the cwd is not an authorization key here
 * any more than it is in the resume list, and a session we have no cwd for is
 * shown everything rather than nothing.
 */
export function canvasCwdForSession(sessionId: string): string | undefined {
  return spawnInfo.get(sessionId)?.cwd
}

/**
 * The config display name this session runs, for the generated TEST PACK name
 * (M3) — "Checkout flow · build 5 · 29 Aug".
 *
 * Read from the spawn record the same way `canvasCwdForSession` reads the
 * project directory, and with the same standing: a label, never a key. A session
 * restored from a previous run has none, and the pack name falls back to the
 * canvas title (see `defaultPackName`).
 */
export function canvasConfigNameForSession(sessionId: string): string | undefined {
  const label = spawnInfo.get(sessionId)?.configLabel?.trim()
  if (!label) return undefined
  // The renderer sends `customName || label || 'default'` (TerminalView), so the
  // literal 'default' is its way of saying "this session has no config name" —
  // not the name of a config. Treated as ABSENT here so both surfaces fall
  // through to the canvas title and derive the same pack name; carrying it
  // would put "default · build 5 · 29 Aug" in the agent's reply while the pane
  // showed the subject.
  return label === 'default' ? undefined : label
}

/** Drop a session's link state when its PTY is gone for good. */
export function forgetSessionForCanvas(sessionId: string): void {
  spawnInfo.delete(sessionId)
}

/** Test seam. */
export function _resetCanvasSessionLinkForTest(): void {
  spawnInfo.clear()
}
