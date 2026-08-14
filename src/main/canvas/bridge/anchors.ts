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

function roleIn(ctx: AnchorContext, el: Element): string {
  let role = ctx.roleCache.get(el)
  if (role === undefined) {
    role = roleOf(el)
    ctx.roleCache.set(el, role)
  }
  return role
}

function nameIn(ctx: AnchorContext, el: Element): string {
  let name = ctx.nameCache.get(el)
  if (name === undefined) {
    name = nameOf(el)
    ctx.nameCache.set(el, name)
  }
  return name
}

/** role (or bare tag where no role resolves) of every meaningful ancestor,
 *  outermost first. The subject element itself is NOT in its own path. */
export function ancestorPathOf(el: Element, ctx: AnchorContext): string {
  const cached = ctx.pathCache.get(el)
  if (cached !== undefined) return cached
  const parts: string[] = []
  let cur = parentOf(el)
  while (cur && cur !== document.body && cur !== document.documentElement && parts.length < PATH_MAX_SEGMENTS) {
    if (isMeaningful(cur)) parts.push(roleIn(ctx, cur) || cur.tagName.toLowerCase())
    cur = parentOf(cur)
  }
  const path = parts.reverse().join('>')
  ctx.pathCache.set(el, path)
  return path
}

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
 *  to be escaped into CSS syntax to be looked up. */
function findByUxId(id: string, ctx: AnchorContext): Element | null {
  for (const el of ctx.scan) {
    if (el.getAttribute('data-ux-id') === id) return el
  }
  return null
}

function describeMatch(ctx: AnchorContext, el: Element, via: 'ux-id' | 'fingerprint'): CanvasAnchorResolution {
  const resolution: CanvasAnchorResolution = {
    found: true,
    via,
    box: boxOf(el),
    role: roleIn(ctx, el),
    name: nameIn(ctx, el),
  }
  const uxId = el.getAttribute('data-ux-id')
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
      const candidates: Element[] = []
      for (const el of ctx.scan) {
        if (matchesFingerprint(ctx, el, anchor.role, anchor.name, anchor.ancestorPath)) candidates.push(el)
      }
      const el = candidates[anchor.ordinal] ?? (candidates.length === 1 ? candidates[0] : undefined)
      return el ? describeMatch(ctx, el, 'fingerprint') : { found: false }
    }
    // 'plan-step' (P5) and anything malformed: not resolvable in a web page.
    return { found: false }
  })
}
