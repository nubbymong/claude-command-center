// Host-boundary guards for content-supplied geometry (spec §3.2 / adversarial
// review 2026-08-11). The Agent Canvas content frame can postMessage the host
// DIRECTLY — its in-page bridge's caps and throttling are not a host boundary —
// so every number that reaches the Excalidraw glass or the overlay DOM must be
// finite-guarded here, and every string length-capped. Untreated, a NaN scroll
// reaches updateScene AND permanently wedges the repin self-heal
// (glassNeedsRepin's `Math.abs(x - NaN) > tol` is always false), silently
// detaching the glass from the content.
//
// This lives in its own module (not inline in the pane) so the regression suite
// imports the SAME code the pane runs — a hand-copied mirror could drift green.

import {
  MAX_INSPECT_CHAIN,
  MAX_RESOLVE_ANCHORS,
  type AnchorRef,
  type CanvasAnchorResolution,
  type CanvasHitInfo,
  type CanvasInspectEntry,
  type CanvasInspectResult,
  type CanvasViewportInfo,
  type Rect,
} from '../../shared/canvas'
// THE rule for page-authored text, and the ONLY copy of it. The content side
// (src/main/canvas/bridge/semantics.ts and anchors.ts) imports the same
// functions from the same module and must go on doing so: an element is
// re-found by comparing these strings for exact equality, so a clean applied
// on one side only is a permanent re-anchoring failure, not a cosmetic
// difference. See the header of canvas-page-text.ts.
import { CANVAS_PATH_MAX, CANVAS_TEXT_MAX, canvasPageText } from '../../shared/canvas-page-text'

const HIT_STRING_MAX = CANVAS_TEXT_MAX
const PATH_STRING_MAX = CANVAS_PATH_MAX
/** Bridge ordinals are small by construction; anything huge is a forgery. */
const ORDINAL_MAX = 1_000_000

export function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * A hit string on its way to the screen — the transient hover readout.
 *
 * Sheds the same class `storableString` does, even though nothing here is
 * stored. What it feeds is the chip that names the element under the pointer,
 * and that chip carries the `page-reported` marker: a bidi override inside a
 * page-authored name reorders the line it is printed on, which is the one place
 * the attribution is easiest to walk away from. The reviewer reads this readout
 * while hunting for the element they are about to write a note against, so it
 * has to say what it says.
 */
export function clampString(value: unknown): string {
  return canvasPageText(value, HIT_STRING_MAX)
}

export function safeRect(rect: Rect | undefined): Rect {
  return {
    x: finite(rect?.x, 0),
    y: finite(rect?.y, 0),
    width: Math.max(0, finite(rect?.width, 0)),
    height: Math.max(0, finite(rect?.height, 0)),
  }
}

export function safeViewport(vp: Partial<CanvasViewportInfo> | undefined): CanvasViewportInfo {
  return {
    scrollX: finite(vp?.scrollX, 0),
    scrollY: finite(vp?.scrollY, 0),
    width: finite(vp?.width, 0),
    height: finite(vp?.height, 0),
    dpr: finite(vp?.dpr, 1) || 1,
    // Never 0 — coordinate transforms divide by scale.
    scale: finite(vp?.scale, 1) || 1,
  }
}

export function safeHit(hit: CanvasHitInfo | undefined): CanvasHitInfo {
  return {
    role: clampString(hit?.role),
    name: clampString(hit?.name),
    tag: clampString(hit?.tag),
    ...(hit?.uxId ? { uxId: clampString(hit.uxId) } : {}),
    box: safeRect(hit?.box),
  }
}

// ── P3: inspect chains and anchor resolutions ───────────────────────────────
// These replies feed the annotation store (via IPC, where main re-validates),
// so beyond the finite/length rules the strings also shed control characters —
// main rejects those outright, and a hostile page must not be able to make a
// legitimate note refuse to save by poisoning a role string.
//
// What comes back out of this function is what gets STORED as an anchor and
// replayed to the content side for matching, so it is the half of the equality
// the host owns. The other half is minted by src/main/canvas/bridge/anchors.ts
// (roleIn / nameIn / ancestorPathOf) out of `canvasPageText`, the same call.

function storableString(value: unknown, max: number): string {
  return canvasPageText(value, max)
}

function safeInspectEntry(entry: Partial<CanvasInspectEntry> | undefined): CanvasInspectEntry {
  const fp = entry?.fingerprint as Partial<CanvasInspectEntry['fingerprint']> | undefined
  const ordinal = finite(fp?.ordinal, 0)
  return {
    role: storableString(entry?.role, HIT_STRING_MAX),
    name: storableString(entry?.name, HIT_STRING_MAX),
    tag: storableString(entry?.tag, HIT_STRING_MAX),
    ...(entry?.uxId ? { uxId: storableString(entry.uxId, PATH_STRING_MAX) } : {}),
    box: safeRect(entry?.box),
    fingerprint: {
      role: storableString(fp?.role, HIT_STRING_MAX),
      name: storableString(fp?.name, HIT_STRING_MAX),
      ancestorPath: storableString(fp?.ancestorPath, PATH_STRING_MAX),
      ordinal: Math.min(ORDINAL_MAX, Math.max(0, Math.floor(ordinal))),
    },
  }
}

export function safeInspectResult(raw: unknown): CanvasInspectResult {
  const chain = (raw as { chain?: unknown } | null)?.chain
  if (!Array.isArray(chain)) return { chain: [] }
  return { chain: chain.slice(0, MAX_INSPECT_CHAIN).map((e) => safeInspectEntry(e as Partial<CanvasInspectEntry>)) }
}

/**
 * One resolution, checked against the anchor it claims to answer.
 *
 * Shape bounds are not enough here. This reply decides what the resolution
 * checklist tells the reviewer about their OWN open issues, and it is written
 * by the artifact under review: a page that answers `found: true` to everything
 * marks every outstanding note as tracked and points the highlight wherever it
 * likes (adversarial review, 2026-08-14). The host cannot measure the page, so
 * it checks the only thing it independently holds — the anchor it sent — and
 * refuses claims that are inconsistent with it:
 *
 *   · the `via` must be the mechanism that anchor could resolve by;
 *   · a ux-id match must be the id we asked about, not another one;
 *   · a fingerprint match must carry the role and name that fingerprint HAS
 *     (the resolver matches on exact equality, so an honest reply always does);
 *   · the box must be a real place on the page — a zero-area "found" is
 *     nowhere to point a reviewer, so it is reported as needing re-pointing.
 *
 * Where the host holds the value itself it emits ITS copy rather than the
 * page's echo, so a matched anchor cannot smuggle a different identity through
 * the field that names it. What survives all of that is still the page's
 * ASSERTION that the element is there — no host-side measurement of a
 * cross-origin frame exists — which is why the checklist presents it as one.
 */
function checkedResolution(anchor: AnchorRef | undefined, entry: Partial<CanvasAnchorResolution> | undefined): CanvasAnchorResolution {
  if (!entry || entry.found !== true) return { found: false }
  if (!anchor || typeof anchor !== 'object') return { found: false }
  const found = entry as Partial<Extract<CanvasAnchorResolution, { found: true }>>
  const box = safeRect(found.box)
  if (box.width <= 0 || box.height <= 0) return { found: false }

  if (anchor.kind === 'ux-id') {
    if (found.via !== 'ux-id') return { found: false }
    // Both halves of every equality below run through `storableString`, which
    // is `canvasPageText` — the SAME call the content side puts its live values
    // through (bridge/anchors.ts). Comparing a cleaned stored value against an
    // uncleaned live one is what made a present, unchanged element read as
    // "needs re-pointing" on every re-render (adversarial re-attack,
    // 2026-08-15), and cleaning the anchor here costs nothing: the host already
    // emits its own cleaned copy rather than the page's echo, so nothing is
    // smuggled through by the normalisation.
    const wantId = storableString(anchor.id, PATH_STRING_MAX)
    if (typeof found.uxId === 'string' && storableString(found.uxId, PATH_STRING_MAX) !== wantId) return { found: false }
    return {
      found: true,
      via: 'ux-id',
      box,
      role: storableString(found.role, HIT_STRING_MAX),
      name: storableString(found.name, HIT_STRING_MAX),
      uxId: wantId,
    }
  }

  if (anchor.kind === 'fingerprint') {
    if (found.via !== 'fingerprint') return { found: false }
    // EXACT equality, on values both sides produced with the same rule. It
    // holds only because the content side mints `found.role`/`found.name`
    // through `canvasPageText` too (bridge/anchors.ts `describeMatch`); while
    // it did not, this line refused every honest reply whose name carried an
    // emoji ZWJ sequence, a Persian ZWNJ or a bidi control — permanently.
    // The reply must actually CARRY both fields — a missing one is not a match
    // for an anchor whose role or name is legitimately empty, which is what a
    // bare `storableString(undefined) === storableString('')` would have made
    // it.
    if (typeof found.role !== 'string' || typeof found.name !== 'string') return { found: false }
    const wantRole = storableString(anchor.role, HIT_STRING_MAX)
    const wantName = storableString(anchor.name, HIT_STRING_MAX)
    if (storableString(found.role, HIT_STRING_MAX) !== wantRole) return { found: false }
    if (storableString(found.name, HIT_STRING_MAX) !== wantName) return { found: false }
    return {
      found: true,
      via: 'fingerprint',
      box,
      role: wantRole,
      name: wantName,
      ...(found.uxId ? { uxId: storableString(found.uxId, PATH_STRING_MAX) } : {}),
    }
  }

  // 'plan-step' (P5) and anything malformed: nothing in a web page resolves it,
  // so a claim that something did is a false one by construction.
  return { found: false }
}

/** 1:1 with the anchors WE sent: the reply is trimmed/padded to that list, so a
 *  page can neither add resolutions nor shift them out of correspondence — and
 *  each one is then checked against the anchor at its index. */
export function safeAnchorResolutions(raw: unknown, anchors: AnchorRef[]): CanvasAnchorResolution[] {
  const asked = Array.isArray(anchors) ? anchors.slice(0, MAX_RESOLVE_ANCHORS) : []
  const list = (raw as { results?: unknown } | null)?.results
  const out: CanvasAnchorResolution[] = []
  for (let i = 0; i < asked.length; i++) {
    const entry = Array.isArray(list) ? (list[i] as Partial<CanvasAnchorResolution> | undefined) : undefined
    out.push(checkedResolution(asked[i], entry))
  }
  return out
}
