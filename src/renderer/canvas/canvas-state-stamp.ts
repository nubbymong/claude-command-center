// The STATE STAMP: what the screen was, structurally, when a note was started.
//
// A screenshot shows a reviewer what they saw. It does not tell an agent which
// dialog was open, which control had focus, or which of nine fields the user had
// actually changed — those are the facts a fix is written against, and they are
// exactly the ones a picture hides. So every note in Testing mode carries this
// beside its shot, and the agent reads THIS first (the shot is fetched only when
// it needs pixels).
//
// The rule the whole module is built around: STRUCTURE, NEVER CONTENT. A field
// contributes its identity (role, accessible name, `data-ux-id`) and one of four
// fill states; it never contributes a character of what was typed into it. That
// is not a filter applied at the end — it is the shape of the code. Nothing here
// spreads a snapshot node, so a field the bridge might one day add cannot arrive
// in a stamp by default; every value is copied by name.
//
// `changed` is the one classification that needs history: it means "the user
// altered this during the run", measured against the BASELINE snapshot taken
// when this version first loaded. Comparing LENGTHS is what makes that possible
// without ever holding either text.

import {
  MAX_STAMP_DIALOGS,
  MAX_STAMP_FIELDS,
  MAX_STAMP_ROUTE_CHARS,
  MAX_STAMP_TARGET_CHARS,
  MAX_STAMP_TITLE_CHARS,
  type CanvasSnapshotResult,
  type CanvasViewportInfo,
  type EvidenceStateStamp,
  type FieldFill,
  type SnapshotNode,
  type StampTarget,
} from '../../shared/canvas'
import { canvasPageText } from '../../shared/canvas-page-text'

/** Roles that mean "a modal is over the page". */
const DIALOG_ROLES = new Set(['dialog', 'alertdialog'])

/**
 * A page-reported string, made safe to store and to show.
 *
 * DELEGATED, not re-implemented. This used to carry its own code-point test for
 * the control class, and that test covered Cc plus the two line separators and
 * stopped there — so the FORMAT class (Cf) walked straight through it, and a
 * route or a title carrying a right-to-left override reached the stamp, the
 * trail and the `canvas_review` payload intact. One override reverses the rest
 * of the line, so the reviewer reads something other than what was stored and
 * the agent is handed something other than what the reviewer read: the
 * 2026-08-15 bidi finding, re-opened on a new path.
 *
 * `canvasPageText` is the ONE cleaner this pipeline has — Cc, Cf, Zl, Zp, plus
 * the cap — and it is the one the bridge, the anchor fingerprints and
 * `safeHit` already run. A second list here is not a second defence; it is the
 * next place the two drift apart. The strip semantics come with it: a control
 * character is REMOVED rather than replaced by a space, which is what both
 * sides of the anchoring comparison do.
 */
export function reportedStampText(value: unknown, max: number): string {
  return canvasPageText(value, max)
}

/** Identity only. Built field by field — never `{...node}` — so a snapshot
 *  gaining a value-bearing field can never leak into a stamp by default. */
function targetOf(node: SnapshotNode): StampTarget {
  const uxId = reportedStampText(node.uxId, MAX_STAMP_TARGET_CHARS)
  return {
    role: reportedStampText(node.role, MAX_STAMP_TARGET_CHARS),
    name: reportedStampText(node.name, MAX_STAMP_TARGET_CHARS),
    ...(uxId ? { uxId } : {}),
  }
}

/**
 * Is this node a form CONTROL?
 *
 * `state.type` is the bridge's own marker: it is set for `input`/`select`/
 * `textarea` and for a `contenteditable` (as `'contenteditable'`), and for
 * nothing else. The rest of `state` — `inert`, `opacity`, `srOnly` — rides any
 * node at all, so testing for `state` alone would call a dimmed `<div>` a field.
 */
function isField(node: SnapshotNode): boolean {
  return typeof node.state?.type === 'string' && node.state.type.length > 0
}

/**
 * How a field is identified ACROSS snapshots.
 *
 * Not `ref` — that is documented as stable within ONE snapshot and is minted
 * fresh on every walk, so a baseline keyed by it would match nothing. A
 * `data-ux-id` is the authoring contract's own stable handle; without one, the
 * role and accessible name together are the best the page offers.
 *
 * Two identically-named inputs COLLIDE, and the collision cuts both ways — it is
 * not the conservative miss it might look like. The baseline map keeps the LAST
 * colliding field's length, so a field can read `filled` when it was in fact
 * changed, and equally `changed` when it was never touched, having inherited its
 * twin's baseline. That is the price of a page whose inputs carry no
 * distinguishing identity, and the answer for a page that cares is the one the
 * authoring skill already asks for: a stable `data-ux-id`. A fill state is a
 * hint about where to look, never a claim to act on alone.
 */
function fieldKey(node: SnapshotNode): string {
  const uxId = reportedStampText(node.uxId, MAX_STAMP_TARGET_CHARS)
  if (uxId) return `u:${uxId}`
  const role = reportedStampText(node.role, MAX_STAMP_TARGET_CHARS)
  const name = reportedStampText(node.name, MAX_STAMP_TARGET_CHARS)
  return `n:${role}|${name}`
}

/**
 * The run's baseline: how long every field's contents were when this version
 * first loaded.
 *
 * LENGTHS, not values — that is the whole trick. "The user changed this field"
 * is derivable from a length that moved, and a length that did not move on a
 * field the user retyped identically is a miss nobody is harmed by.
 */
export type StampBaseline = ReadonlyMap<string, number>

export function baselineFromSnapshot(snapshot: CanvasSnapshotResult | null | undefined): StampBaseline {
  const out = new Map<string, number>()
  if (!snapshot) return out
  walk(snapshot.root, (node) => {
    if (isField(node)) out.set(fieldKey(node), node.state?.valueLength ?? 0)
  })
  return out
}

/** Depth-first, document order, bounded by the snapshot's own node cap. */
function walk(node: SnapshotNode | undefined, visit: (node: SnapshotNode) => void): void {
  if (!node) return
  const stack: SnapshotNode[] = [node]
  while (stack.length > 0) {
    const current = stack.pop() as SnapshotNode
    visit(current)
    const children = current.children
    if (!Array.isArray(children)) continue
    // Pushed in reverse so the pop order is document order.
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
}

/**
 * How this field stood — one of four, and never a value.
 *
 * The order is the priority order, and it is deliberate: `invalid` outranks
 * everything because it is what the reviewer is usually looking at; `changed`
 * outranks `filled` because "the user did this" is a stronger claim than "there
 * is text here"; `filled` outranks `empty` for the obvious reason.
 */
export function fieldFill(node: SnapshotNode, baseline: StampBaseline | null): FieldFill {
  if (node.state?.ariaInvalid === true) return 'invalid'
  const length = node.state?.valueLength ?? 0
  const before = baseline?.get(fieldKey(node))
  if (before !== undefined && before !== length) return 'changed'
  return length > 0 ? 'filled' : 'empty'
}

export interface EvidenceStampInput {
  /** A SANITISED snapshot of the frame, or null when the frame could not be
   *  asked. A stamp without one still carries the viewport and the host's own
   *  clock — less evidence is not no evidence. */
  snapshot: CanvasSnapshotResult | null
  /** The run's first-load snapshot, folded to lengths. Null on a run whose
   *  baseline was never taken; every field then reports `filled`/`empty`, which
   *  is honest rather than wrong. */
  baseline: StampBaseline | null
  /** The frame's last viewport report. */
  viewport: CanvasViewportInfo | null
  /** The PANE's zoom — host-owned, so it is the one number here the page cannot
   *  influence. */
  zoom: number
  /** ISO, host-minted. */
  at: string
}

/**
 * Fold a snapshot into the stamp a note carries.
 *
 * Pure: no IPC, no DOM, no clock of its own. That is what lets the privacy bar
 * be a unit test — hand it a hostile snapshot, serialise the result, and grep.
 */
export function buildEvidenceStamp(input: EvidenceStampInput): EvidenceStateStamp {
  const { snapshot, baseline, viewport, zoom, at } = input

  const dialogs: StampTarget[] = []
  const fields: Array<StampTarget & { fill: FieldFill }> = []
  let focused: StampTarget | undefined
  const focusedRef = typeof snapshot?.focusedRef === 'string' ? snapshot.focusedRef : null

  if (snapshot) {
    walk(snapshot.root, (node) => {
      if (DIALOG_ROLES.has(node.role) && dialogs.length < MAX_STAMP_DIALOGS) dialogs.push(targetOf(node))
      if (isField(node) && fields.length < MAX_STAMP_FIELDS) {
        fields.push({ ...targetOf(node), fill: fieldFill(node, baseline) })
      }
      if (focusedRef !== null && focused === undefined && node.ref === focusedRef) focused = targetOf(node)
    })
  }

  const page = snapshot?.page
  const route = page ? reportedStampText(`${page.pathname ?? ''}${page.hash ?? ''}`, MAX_STAMP_ROUTE_CHARS) : ''
  const title = page ? reportedStampText(page.title, MAX_STAMP_TITLE_CHARS) : ''

  return {
    capturedAt: at,
    ...(title ? { title } : {}),
    ...(route ? { route } : {}),
    viewport: {
      width: finite(viewport?.width),
      height: finite(viewport?.height),
      scrollX: finite(viewport?.scrollX),
      scrollY: finite(viewport?.scrollY),
      dpr: finite(viewport?.dpr, 1),
      zoom: finite(zoom, 1),
    },
    dialogs,
    ...(focused ? { focused } : {}),
    fields,
  }
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * The stamp as the chips the recall view shows — the same summary the MCP
 * serializer prints in words, so the user and the agent read one description.
 *
 * Route, title and a dialog's name are the PAGE's account of itself and are
 * marked as such wherever these are rendered; the counts are the host's own
 * arithmetic over its own classification, so they are not.
 */
export function stampChips(stamp: EvidenceStateStamp): Array<{ text: string; pageReported: boolean }> {
  const chips: Array<{ text: string; pageReported: boolean }> = []
  if (stamp.route) chips.push({ text: `route ${stamp.route}`, pageReported: true })
  if (stamp.dialogs.length > 0) {
    chips.push({
      text: stamp.dialogs.length === 1 ? 'dialog open' : `${stamp.dialogs.length} dialogs open`,
      pageReported: true,
    })
  }
  const counts: Record<FieldFill, number> = { empty: 0, filled: 0, changed: 0, invalid: 0 }
  for (const field of stamp.fields) counts[field.fill] += 1
  const fields = (n: number): string => `${n} field${n === 1 ? '' : 's'}`
  if (counts.changed > 0) chips.push({ text: `${fields(counts.changed)} changed`, pageReported: false })
  if (counts.filled > 0) chips.push({ text: `${fields(counts.filled)} filled`, pageReported: false })
  if (counts.invalid > 0) chips.push({ text: `${counts.invalid} invalid`, pageReported: false })
  if (stamp.focused) {
    chips.push({ text: `focus ${stamp.focused.name || stamp.focused.role}`, pageReported: true })
  }
  return chips
}

/**
 * One trail entry, split into what the HOST says and what the PAGE said.
 *
 * The shared `trailAction` renders the same entry as one string for the agent,
 * and this is deliberately NOT a second copy of it: the pane has an obligation
 * the transcript does not, which is to mark page-authored identity where it
 * appears (PAGE_REPORTED_MARK). A single string cannot be half-marked, so the
 * split lives here and the CLOCK — the part that really would be a duplicate —
 * comes from `trailClockTime` in the shared module.
 */
export function trailLineParts(entry: {
  kind: string
  target?: StampTarget | null
  route?: string
  scrollY?: number
}): { verb: string; subject: string; subjectIsPageReported: boolean } {
  switch (entry.kind) {
    case 'click':
      return {
        verb: 'click',
        subject: entry.target ? entry.target.name || entry.target.role : 'the page',
        subjectIsPageReported: !!entry.target,
      }
    case 'typed':
      return {
        verb: 'typed into',
        subject: entry.target ? entry.target.name || entry.target.role : '',
        subjectIsPageReported: true,
      }
    case 'navigate':
      return { verb: 'navigate', subject: entry.route ?? '', subjectIsPageReported: true }
    case 'scroll':
      return { verb: 'scrolled to', subject: `${Math.round(entry.scrollY ?? 0)}px`, subjectIsPageReported: false }
    default:
      return { verb: 'note saved', subject: '', subjectIsPageReported: false }
  }
}
