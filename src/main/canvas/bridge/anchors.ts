// Anchoring (P3, spec §4): how an element is remembered across re-renders, and
// how a remembered element is found again.
//
// Two identities per element: its `data-ux-id` (primary — the authoring
// contract promises it survives revisions) and its FINGERPRINT (fallback —
// role + accessible name + the role/tag path of its meaningful ancestors +
// its ordinal among look-alikes). The fingerprint is computed HERE, content
// side, because ordinal and ancestry need the whole document in reach; the
// host only stores and replays what this module mints.
//
// Resolution is deliberately conservative. `candidates[ordinal]` is the match;
// when the ordinal no longer exists the match is accepted only if the field of
// candidates has collapsed to exactly ONE — a shrunken list still describes the
// same thing, an ambiguous list does not, and a wrong "found" re-points the
// user's note at someone else's element, which is worse than honestly asking
// them to re-point it ("needs re-pointing" in the checklist).
//
// Everything here works from an AnchorContext: one document scan and one
// role/name memo shared across a whole batch. An inspect computes a
// fingerprint per chain entry and the accessible-name algorithm is the
// expensive step — without the memo a single click on a page of 500 buttons
// recomputes accname thousands of times.

import type { AnchorRef, CanvasAnchorResolution, CanvasFingerprint } from '../../../shared/canvas'
// The host cleans every page-authored string it STORES with these same calls
// (src/renderer/utils/canvas-geometry-guard.ts: clampString / storableString).
// Every identity this module mints, matches on, or echoes back has to go
// through them too — the whole mechanism is string equality between a stored
// value and a recomputed one, so a clean applied on one side only is a
// permanent "needs re-pointing". See src/shared/canvas-page-text.ts.
import { CANVAS_PATH_MAX, CANVAS_TEXT_MAX, canvasPageText } from '../../../shared/canvas-page-text'
import { boxOf } from './measure'
import { isMeaningful, isSkipped, nameOf, parentOf, roleOf } from './semantics'

/** Segments an ancestorPath keeps. Deep enough to disambiguate real layouts;
 *  the path is a locator, not a résumé. */
const PATH_MAX_SEGMENTS = 8

/** How many elements a document scan will look at before it stops. A page past
 *  this is a page where fingerprints are weak evidence anyway — refusing to
 *  scan further keeps a hostile/degenerate document from turning one click
 *  into an unbounded walk. */
const MAX_SCAN_ELEMENTS = 5000

export interface AnchorContext {
  /** Document-order scan, open shadow roots included, capped. */
  scan: Element[]
  roleCache: Map<Element, string>
  nameCache: Map<Element, string>
  pathCache: Map<Element, string>
}

/** Document-order walk of every element, descending into OPEN shadow roots
 *  (the same reach boxMap has), capped at MAX_SCAN_ELEMENTS. */
function allElements(): Element[] {
  const out: Element[] = []
  const visit = (root: ParentNode): void => {
    const children = root.children
    for (let i = 0; i < children.length && out.length < MAX_SCAN_ELEMENTS; i++) {
      const el = children[i]
      if (!isSkipped(el)) {
        out.push(el)
        if (el.shadowRoot) visit(el.shadowRoot)
        visit(el)
      }
    }
  }
  if (document.documentElement) visit(document.documentElement)
  return out
}

export function createAnchorContext(): AnchorContext {
  return { scan: allElements(), roleCache: new Map(), nameCache: new Map(), pathCache: new Map() }
}

/**
 * The live role, cleaned and bounded exactly as the host will store it.
 *
 * `roleOf` reads a page-authored `role="…"` attribute verbatim: it can carry
 * the format class and it has no length of its own. The host's `storableString`
 * sheds both, so an uncleaned role here compares unequal to its own stored copy
 * forever. Cleaning at the cache means every consumer in this module — the
 * fingerprint, the matcher, the ancestor path, the echoed resolution — is
 * working from the one value.
 */
function roleIn(ctx: AnchorContext, el: Element): string {
  let role = ctx.roleCache.get(el)
  if (role === undefined) {
    role = canvasPageText(roleOf(el), CANVAS_TEXT_MAX)
    ctx.roleCache.set(el, role)
  }
  return role
}

/** The live accessible name. `nameOf` -> `squash` already applies the shared
 *  rule and caps at 80, so this is the same value the host will store; the
 *  belt-and-braces pass costs nothing and keeps the guarantee local to the
 *  place that depends on it. */
function nameIn(ctx: AnchorContext, el: Element): string {
  let name = ctx.nameCache.get(el)
  if (name === undefined) {
    name = canvasPageText(nameOf(el), CANVAS_TEXT_MAX)
    ctx.nameCache.set(el, name)
  }
  return name
}

/** role (or bare tag where no role resolves) of every meaningful ancestor,
 *  outermost first. The subject element itself is NOT in its own path.
 *
 *  Bounded to the host's path length as well as the host's character class: a
 *  page whose ancestors carry 5,000-character roles would otherwise hand the
 *  host a path it truncates on the way in and this module recomputes in full,
 *  which is the same divergence the strip was. Segments are already cleaned by
 *  roleIn; tag names cannot carry the class. */
export function ancestorPathOf(el: Element, ctx: AnchorContext): string {
  const cached = ctx.pathCache.get(el)
  if (cached !== undefined) return cached
  const parts: string[] = []
  let cur = parentOf(el)
  while (cur && cur !== document.body && cur !== document.documentElement && parts.length < PATH_MAX_SEGMENTS) {
    if (isMeaningful(cur)) parts.push(roleIn(ctx, cur) || cur.tagName.toLowerCase())
    cur = parentOf(cur)
  }
  const path = canvasPageText(parts.reverse().join('>'), CANVAS_PATH_MAX)
  ctx.pathCache.set(el, path)
  return path
}

/** A `data-ux-id` as the host stores it. The primary anchor is compared by
 *  equality too, so the attribute has to be read through the same rule its
 *  stored copy went through — otherwise an id holding a zero-width space is
 *  stored clean, looked up dirty, and never resolves again. */
function uxIdOf(el: Element): string {
  return canvasPageText(el.getAttribute('data-ux-id'), CANVAS_PATH_MAX)
}

/**
 * Exact string equality, three times over. `role`/`name`/`ancestorPath` come
 * from a STORED anchor that the host cleaned with `canvasPageText`; roleIn,
 * nameIn and ancestorPathOf clean the live element with the same call. Both
 * halves must go on doing that — this is the comparison the whole of §4 rests
 * on, and it has already been broken once by cleaning only one of them.
 */
function matchesFingerprint(ctx: AnchorContext, el: Element, role: string, name: string, ancestorPath: string): boolean {
  // Role first: a cheap attribute/table lookup that eliminates almost
  // everything before the accessible-name computation (the expensive step)
  // ever runs.
  if (roleIn(ctx, el) !== role) return false
  if (nameIn(ctx, el) !== name) return false
  return ancestorPathOf(el, ctx) === ancestorPath
}

export function fingerprintOf(el: Element, ctx: AnchorContext): CanvasFingerprint {
  const role = roleIn(ctx, el)
  const name = nameIn(ctx, el)
  const ancestorPath = ancestorPathOf(el, ctx)
  let ordinal = 0
  for (const candidate of ctx.scan) {
    if (candidate === el) break
    if (matchesFingerprint(ctx, candidate, role, name, ancestorPath)) ordinal++
  }
  return { role, name, ancestorPath, ordinal }
}

/** The first element carrying this exact data-ux-id, open shadow roots
 *  included. Attribute COMPARISON rather than a selector, so an id never has
 *  to be escaped into CSS syntax to be looked up — and through `uxIdOf`, so
 *  both sides of the comparison have had the same rule applied. */
function findByUxId(id: string, ctx: AnchorContext): Element | null {
  const wanted = canvasPageText(id, CANVAS_PATH_MAX)
  if (!wanted) return null
  for (const el of ctx.scan) {
    if (el.hasAttribute('data-ux-id') && uxIdOf(el) === wanted) return el
  }
  return null
}

/** The reply the host will check against the anchor it sent. Every field it
 *  can compare is emitted through the shared rule, so an honest match reads as
 *  one: `checkedResolution` refuses on `found.role !== anchor.role ||
 *  found.name !== anchor.name` and on `found.uxId !== anchor.id`. */
function describeMatch(ctx: AnchorContext, el: Element, via: 'ux-id' | 'fingerprint'): CanvasAnchorResolution {
  const resolution: CanvasAnchorResolution = {
    found: true,
    via,
    box: boxOf(el),
    role: roleIn(ctx, el),
    name: nameIn(ctx, el),
  }
  const uxId = uxIdOf(el)
  if (uxId) resolution.uxId = uxId
  return resolution
}

/**
 * Resolve stored anchors against the CURRENT document, 1:1 with the input.
 *
 * One context serves the whole batch — the checklist re-anchors every open
 * note in a single request (D12: one re-anchor pass per turn), and a
 * per-anchor document walk would multiply that by the page.
 */
export function resolveAnchors(anchors: AnchorRef[]): CanvasAnchorResolution[] {
  const ctx = createAnchorContext()
  return anchors.map((anchor): CanvasAnchorResolution => {
    if (!anchor || typeof anchor !== 'object') return { found: false }
    if (anchor.kind === 'ux-id' && typeof anchor.id === 'string' && anchor.id.length > 0) {
      const el = findByUxId(anchor.id, ctx)
      return el ? describeMatch(ctx, el, 'ux-id') : { found: false }
    }
    if (
      anchor.kind === 'fingerprint' &&
      typeof anchor.role === 'string' &&
      typeof anchor.name === 'string' &&
      typeof anchor.ancestorPath === 'string' &&
      typeof anchor.ordinal === 'number' &&
      Number.isInteger(anchor.ordinal) &&
      anchor.ordinal >= 0
    ) {
      // Run the incoming anchor through the rule as well. Anything the host
      // stored today is already clean, so this is a no-op on it; what it
      // rescues is a review written before the host cleaned at all, whose
      // stored name still carries the joiner its element's live name no longer
      // will. Both sides of every comparison, one rule.
      const wantRole = canvasPageText(anchor.role, CANVAS_TEXT_MAX)
      const wantName = canvasPageText(anchor.name, CANVAS_TEXT_MAX)
      const wantPath = canvasPageText(anchor.ancestorPath, CANVAS_PATH_MAX)
      const candidates: Element[] = []
      for (const el of ctx.scan) {
        if (matchesFingerprint(ctx, el, wantRole, wantName, wantPath)) candidates.push(el)
      }
      const el = candidates[anchor.ordinal] ?? (candidates.length === 1 ? candidates[0] : undefined)
      return el ? describeMatch(ctx, el, 'fingerprint') : { found: false }
    }
    // 'plan-step' (P5) and anything malformed: not resolvable in a web page.
    return { found: false }
  })
}
