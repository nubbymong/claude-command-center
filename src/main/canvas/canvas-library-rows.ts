// The project Library, composed in MAIN (M4).
//
// One row per ARTEFACT RUN, not per canvas. A canvas accumulates several
// artefacts over its life — a mockup run, then a plan, then a test pack — and
// the old canvas-level list could only ever describe the newest of them, so the
// rest became invisible the moment a second kind was rendered.
//
// WHY THIS LIVES IN MAIN AND NOT IN THE RENDERER. Three reasons, and the first
// is the one that matters:
//
//   1. THE PRIVACY RULE. An in-flight canvas whose owner is LIVE and is not the
//      caller is not the caller's to see. A filter applied in the renderer is a
//      filter that shipped the data first, so the rows are never built here at
//      all — `listCanvasesForLibrary` withholds them.
//   2. The verdict, the owed text and the note counts all need the REVIEW store
//      as well as the canvas store, and only main holds both. Two derivations
//      of "who is this waiting on" is exactly how the pane's pill and the
//      Library's badge came to disagree.
//   3. `truncated` is only honest if the search, the tab and the filter are
//      applied before the cap — which means applying them where the cap is.
//
// Everything on a row is a LABEL. None of it is a key: an action names a canvas
// and a version, and every mutating channel re-checks ownership itself.

import {
  artifactPhaseOf,
  artifactRuns,
  libraryRowKindOf,
  verdictLabel,
  type Annotation,
  type CanvasLibraryFilter,
  type CanvasLibraryResult,
  type CanvasLibraryRow,
  type CanvasLibraryTab,
  type CanvasVersion,
  type Review,
} from '../../shared/canvas'
import { listCanvasesForLibrary, type LibraryCanvas } from './canvas-store'
import { getReviewSnapshotForCanvas } from './canvas-review-store'

/**
 * How many rows one call returns.
 *
 * A library open must not become an unbounded wall, and the cap is applied
 * AFTER the sort — so what survives is the most relevant, never an arbitrary
 * prefix. `truncated` says when something did not fit.
 */
const MAX_LIBRARY_ROWS = 200

/**
 * How many canvases get their review file read per call.
 *
 * Every read is synchronous and fully validated, so an unbounded sweep turns
 * one library open into a hundred file reads on the UI thread. Own canvases are
 * always read (they are the rows the user acts on); the rest share this budget,
 * and a row past it still renders — with its version-derived verdict and no
 * note counts, which is honest rather than wrong.
 */
const MAX_REVIEW_READS = 60

/** Evidence thumbs offered per pack row. Six is a screenful; the Library loads
 *  the images themselves lazily, one `canvas:evidenceRead` per card. */
const MAX_ROW_EVIDENCE = 6

/** Longest note excerpt carried on an evidence thumb. The card shows two lines;
 *  anything past this is weight on the wire nobody reads. */
const MAX_EVIDENCE_NOTE_CHARS = 160

/** Longest search string honoured. A query past this matches nothing a human
 *  typed, and bounding it bounds the per-row `includes` work. */
const MAX_QUERY_CHARS = 200

interface ReviewSnapshot {
  reviews: Review[]
  annotations: Annotation[]
}

const EMPTY_SNAPSHOT: ReviewSnapshot = { reviews: [], annotations: [] }

export interface LibraryRowsArgs {
  askingSessionId: string
  projectCwd?: string
  openTileSessionIds?: readonly string[]
  isSessionLive?: (sessionId: string) => boolean
  /** Free text, lowercased and matched against titles, pack names and note
   *  text. Main-side, so `truncated` counts what actually matched. */
  query?: string
  tab?: CanvasLibraryTab
  filter?: CanvasLibraryFilter
  /** configId → display name, resolved by the caller AT READ (config-manager
   *  lives outside this module's reach). A config that no longer exists simply
   *  has no name — never a placeholder, never the stale label. */
  configNameOf?: (configId: string) => string | undefined
  /** The label recorded at spawn for the session that owns a canvas, used only
   *  when the config id resolves to nothing. */
  spawnLabelOf?: (sessionId: string) => string | undefined
}

/** The rounds and notes on one canvas, or an empty snapshot. A canvas whose
 *  review store will not read is not skipped — the versions are still the
 *  user's work — it simply reports nothing outstanding. */
function snapshotFor(canvasId: string, budget: { left: number }, always: boolean): ReviewSnapshot {
  if (!always && budget.left <= 0) return EMPTY_SNAPSHOT
  if (!always) budget.left--
  return getReviewSnapshotForCanvas(canvasId) ?? EMPTY_SNAPSHOT
}

/** Which of a run's versions the row is ADDRESSED by: its newest ready one.
 *  Drafts are the agent's own loop and are invisible to the user, so a row can
 *  never be anchored to one. */
function anchorOf(run: readonly CanvasVersion[]): CanvasVersion | undefined {
  for (let i = run.length - 1; i >= 0; i--) {
    if (!run[i].draft) return run[i]
  }
  return undefined
}

/** 'v8' for a mockup or a plan; 'build 5' for a pack — the agent's own label
 *  for the build under test when it gave one, else the version number. */
function versionLabelOf(anchor: CanvasVersion): string {
  if (anchor.mode !== 'uat') return anchor.id
  const build = anchor.source.mode === 'uat' ? anchor.source.buildLabel?.trim() : undefined
  return `build ${build || anchor.id.slice(1)}`
}

/**
 * WHAT IS OWED, in plain words — and, separately, WHOSE MOVE IT IS.
 *
 * Both derived from `artifactPhaseOf` after the settle rules have run, never
 * stored: a stored phase is a phase that can be WRONG, and every strand in the
 * live repros was a stored answer the record had already contradicted.
 *
 * THE TWO ARE NOT THE SAME QUESTION, and conflating them is what "Needs you"
 * got wrong. `owed` is "is anything outstanding here", which is true of a round
 * sitting WITH THE AGENT — the user is waiting, not working. `needsYou` is "is
 * this the USER's move", which is true only of an open version awaiting their
 * decision, or of words they started and never sent. A chip called Needs you
 * that lists everything the agent is holding is a chip that tells the user to
 * look at rows they can do nothing about.
 *
 * `owed` is absent when nothing is outstanding — not the empty string, so the
 * renderer never has to tell two spellings of "nothing" apart.
 */
function owedFor(
  run: readonly CanvasVersion[],
  snapshot: ReviewSnapshot,
  runNotes: readonly Annotation[],
  runReviewIds: ReadonlySet<string>,
): { owed?: string; needsYou: boolean } {
  // Words the user started and never sent. Counted first because they are the
  // user's move whatever else the phase says.
  const draftIds = new Set(snapshot.reviews.filter((r) => r.status === 'draft').map((r) => r.id))
  const unsent = runNotes.filter((a) => draftIds.has(a.reviewId) && runReviewIds.has(a.reviewId)).length

  const phase = artifactPhaseOf(run, snapshot.reviews, snapshot.annotations)
  if (phase.kind === 'needs-you') return { owed: `${phase.versionId} awaiting review`, needsYou: true }
  if (phase.kind === 'with-agent') {
    const live = phase.openNotes + phase.addressedNotes
    // Outstanding, but NOT the user's move. An unsent draft of their own still
    // is, so the flag is reported honestly rather than forced to false here.
    return { owed: `${live} ${live === 1 ? 'note' : 'notes'} with the agent`, needsYou: unsent > 0 }
  }
  if (unsent > 0) return { owed: `${unsent} unsent ${unsent === 1 ? 'note' : 'notes'}`, needsYou: true }
  return { needsYou: false }
}

/**
 * The stamp that describes the NEWEST activity on a run: the anchor's render,
 * or a note written after it. A note is activity too, and a row whose audit
 * line predates the user's last word on it reads as staler than it is.
 *
 * Compared on PARSED time, never on the ISO strings. Lexical order is only
 * correct while every stamp is the same UTC spelling — the same reason
 * `listAllCanvases` moved its own sort off string compare — and an unparseable
 * value must LOSE rather than win by sorting above everything (or below it,
 * depending on its first character). `sanitizeAuditStamp` already refuses one,
 * so this is the second line rather than the first.
 */
function newestAudit(
  canvas: LibraryCanvas,
  anchor: CanvasVersion,
  runNotes: readonly Annotation[],
): { account?: string; sessionLabel?: string; when: string } {
  let when = anchor.createdAt
  let whenMs = Date.parse(when)
  let stamp = anchor.renderedBy ?? canvas.state.createdBy
  for (const note of runNotes) {
    if (!note.author) continue
    const at = Date.parse(note.author.at)
    if (!Number.isFinite(at)) continue
    if (!Number.isFinite(whenMs) || at > whenMs) {
      when = note.author.at
      whenMs = at
      stamp = note.author
    }
  }
  return {
    ...(stamp?.account ? { account: stamp.account } : {}),
    ...(stamp?.sessionLabel ? { sessionLabel: stamp.sessionLabel } : {}),
    when,
  }
}

/** Up to six evidence records off a pack's notes, for the Library's thumbs. The
 *  shot path comes STRAIGHT off the record — the read channel resolves it
 *  against that same record, so a path this row invented would match nothing. */
function evidenceFor(runNotes: readonly Annotation[]): CanvasLibraryRow['evidence'] {
  const out: NonNullable<CanvasLibraryRow['evidence']> = []
  for (const note of runNotes) {
    if (out.length >= MAX_ROW_EVIDENCE) break
    if (!note.evidence) continue
    out.push({
      // Sliced by CODE POINT, not by UTF-16 unit — the repo's idiom (see
      // `defaultPackName`, `sanitizeAuditLabel`). A plain `.slice` cuts a
      // surrogate pair in half at the boundary and the card renders the
      // replacement glyph on any note that ends in an emoji.
      note: Array.from(note.note).slice(0, MAX_EVIDENCE_NOTE_CHARS).join(''),
      ...(note.evidence.stamp.route ? { route: note.evidence.stamp.route } : {}),
      at: note.evidence.stamp.capturedAt,
      shotPath: note.evidence.shotPath,
    })
  }
  return out.length > 0 ? out : undefined
}

/** Does this row match the tab and the filter chip? Applied here, before the
 *  cap, so `truncated` counts what actually matched. */
function passesTabAndFilter(
  row: CanvasLibraryRow,
  needsYou: boolean,
  tab: CanvasLibraryTab,
  filter: CanvasLibraryFilter | undefined,
): boolean {
  if (tab !== 'all' && row.kind !== tab) return false
  switch (filter) {
    case undefined:
      // No chip: the ARCHIVED artefacts are the ones the user has deliberately
      // put down, so they stay out of the default view and have a chip of their
      // own. Everything else shows.
      return !row.archived
    case 'archived':
      return row.archived
    case 'needs-you':
      // The USER's move, not merely "something is outstanding" — see `owedFor`.
      return !row.archived && needsYou
    case 'open':
      return !row.archived && !row.completed
    case 'signed-off':
      return !row.archived && row.completed
    default:
      return true
  }
}

/**
 * THE LIBRARY, as rows.
 *
 * Sort: needs-you first (the rows that are the user's move), then newest
 * activity. Cap after the sort, so what survives is the most relevant.
 */
export function buildLibraryRows(args: LibraryRowsArgs): CanvasLibraryResult {
  const canvases = listCanvasesForLibrary({
    askingSessionId: args.askingSessionId,
    ...(args.projectCwd ? { projectCwd: args.projectCwd } : {}),
    ...(args.openTileSessionIds ? { openTileSessionIds: args.openTileSessionIds } : {}),
    ...(args.isSessionLive ? { isSessionLive: args.isSessionLive } : {}),
  })
  const needle = (args.query ?? '').slice(0, MAX_QUERY_CHARS).trim().toLowerCase()
  const tab: CanvasLibraryTab = args.tab ?? 'all'
  const budget = { left: MAX_REVIEW_READS }
  // Rows carried WITH their needs-you flag. The flag is a main-side decision
  // (it drives the chip and the sort, both applied here) and is deliberately
  // not on the wire: the renderer reads `owed`, and a second, subtly different
  // "is this yours" for it to re-derive is how the pane's pill and the
  // Library's badge came to disagree the last time.
  const built: Array<{ row: CanvasLibraryRow; needsYou: boolean }> = []

  for (const canvas of canvases) {
    // Own canvases are always read: they are the rows the user acts on, and a
    // "review needed" badge must never hide behind a sweep bound.
    const snapshot = snapshotFor(canvas.state.canvasId, budget, canvas.ownedByThisSession)
    const notesByReview = new Map<string, Annotation[]>()
    for (const note of snapshot.annotations) {
      const list = notesByReview.get(note.reviewId)
      if (list) list.push(note)
      else notesByReview.set(note.reviewId, [note])
    }
    // The config's CURRENT name, resolved at read. A rename therefore renames
    // every row rather than leaving a frozen label behind — which is the whole
    // reason the record stores an id and not a name.
    const configName =
      (canvas.state.configId ? args.configNameOf?.(canvas.state.configId) : undefined) ??
      args.spawnLabelOf?.(canvas.state.sessionId)

    for (const run of artifactRuns(canvas.state.versions)) {
      const anchor = anchorOf(run)
      if (!anchor) continue // an all-draft run is invisible to the user
      const runIds = new Set(run.map((v) => v.id))
      const runNotes = snapshot.annotations.filter((a) => runIds.has(a.versionId))
      const runReviewIds = new Set(
        snapshot.reviews.filter((r) => runIds.has(r.versionId)).map((r) => r.id),
      )
      const observations = runNotes.filter((a) => a.state === 'observation').length
      const audit = newestAudit(canvas, anchor, runNotes)
      const completed = !!canvas.state.completed
      const packName = anchor.mode === 'uat' ? anchor.packName : undefined
      const title = packName ?? canvas.state.title ?? 'Untitled'
      const { owed, needsYou } = owedFor(run, snapshot, runNotes, runReviewIds)
      const row: CanvasLibraryRow = {
        canvasId: canvas.state.canvasId,
        anchorVersionId: anchor.id,
        kind: libraryRowKindOf(anchor.mode),
        title,
        verdict: verdictLabel(anchor, { observations }),
        ...(owed ? { owed } : {}),
        archived: !!anchor.archived,
        completed,
        ...(configName ? { configName } : {}),
        audit,
        versionLabel: versionLabelOf(anchor),
        noteCount: runNotes.length,
        ...(anchor.mode === 'uat' ? { evidence: evidenceFor(runNotes) } : {}),
        ownedByThisSession: canvas.ownedByThisSession,
        // READ-ONLY is composed here, never derived in the renderer: a
        // permission the UI computes is a permission that can be computed
        // wrong. Main refuses every mutating channel for a non-owner anyway
        // (see canvas-readonly-boundary.test.ts); this is what makes the UI
        // agree with the refusal instead of offering a button that will fail.
        readOnly: completed && !canvas.ownedByThisSession,
        updatedAt: audit.when,
      }
      // The audit line must not print the same word twice. The session label is
      // the TILE's own name, which is the config's name until the user renames
      // the tile — so when they are the same string there is only one thing to
      // say, and the config column says it.
      if (row.audit.sessionLabel && row.audit.sessionLabel === row.configName) delete row.audit.sessionLabel
      if (!passesTabAndFilter(row, needsYou, tab, args.filter)) continue
      if (needle && !matchesQuery(row, canvas.state.title, runNotes, needle)) continue
      built.push({ row, needsYou })
    }
  }

  built.sort((a, b) => {
    // NEEDS-YOU first — the rows that are the user's move, not merely the ones
    // with something outstanding. A row the agent is holding sorts by recency
    // with everything else.
    const mine = Number(b.needsYou) - Number(a.needsYou)
    if (mine !== 0) return mine
    const at = Date.parse(a.row.updatedAt)
    const bt = Date.parse(b.row.updatedAt)
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at
    return a.row.canvasId < b.row.canvasId ? -1 : a.row.canvasId > b.row.canvasId ? 1 : 0
  })
  const rows = built.map((b) => b.row)
  return {
    rows: rows.length > MAX_LIBRARY_ROWS ? rows.slice(0, MAX_LIBRARY_ROWS) : rows,
    truncated: rows.length > MAX_LIBRARY_ROWS,
  }
}

/**
 * Row title, the CANVAS's own subject, the config name, and the run's own note
 * TEXT.
 *
 * The canvas title is searched SEPARATELY from `row.title`, and that is the
 * point rather than a duplication: a pack row's title is its packName when the
 * user set one, so the subject the canvas was made under — "Checkout flow",
 * which is very likely what they type — is not in `row.title` at all on
 * exactly the rows most likely to have been renamed.
 *
 * The note text is the reason this search is main-side: it is the thing a user
 * actually remembers, and it never leaves main for a row the privacy rule
 * withheld.
 */
function matchesQuery(
  row: CanvasLibraryRow,
  canvasTitle: string | undefined,
  runNotes: readonly Annotation[],
  needle: string,
): boolean {
  if (row.title.toLowerCase().includes(needle)) return true
  if (canvasTitle?.toLowerCase().includes(needle)) return true
  if (row.configName?.toLowerCase().includes(needle)) return true
  return runNotes.some((a) => a.note.toLowerCase().includes(needle))
}
