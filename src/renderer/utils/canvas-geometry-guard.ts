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
  type CanvasAnchorResolution,
  type CanvasHitInfo,
  type CanvasInspectEntry,
  type CanvasInspectResult,
  type CanvasViewportInfo,
  type Rect,
} from '../../shared/canvas'

const HIT_STRING_MAX = 120
const PATH_STRING_MAX = 512
/** Bridge ordinals are small by construction; anything huge is a forgery. */
const ORDINAL_MAX = 1_000_000

/** Content-supplied strings that will be STORED (annotation focus/anchors) as
 *  well as rendered: control characters are stripped, not just length-capped —
 *  the main store rejects them outright, and a note the user wrote must not be
 *  refused because a hostile page put a control byte in a role string. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_G = /[\u0000-\u001F\u007F]/g

export function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function clampString(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, HIT_STRING_MAX) : ''
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

function storableString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(CONTROL_CHARS_G, '').slice(0, max) : ''
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

/** 1:1 with the anchors WE sent: the reply is trimmed/padded to `expected`, so
 *  a page can neither add resolutions nor shift them out of correspondence. */
export function safeAnchorResolutions(raw: unknown, expected: number): CanvasAnchorResolution[] {
  const bounded = Math.max(0, Math.min(expected, MAX_RESOLVE_ANCHORS))
  const list = (raw as { results?: unknown } | null)?.results
  const out: CanvasAnchorResolution[] = []
  for (let i = 0; i < bounded; i++) {
    const entry = Array.isArray(list) ? (list[i] as Partial<CanvasAnchorResolution> | undefined) : undefined
    if (!entry || entry.found !== true) {
      out.push({ found: false })
      continue
    }
    const found = entry as Extract<CanvasAnchorResolution, { found: true }>
    out.push({
      found: true,
      via: found.via === 'fingerprint' ? 'fingerprint' : 'ux-id',
      box: safeRect(found.box),
      role: storableString(found.role, HIT_STRING_MAX),
      name: storableString(found.name, HIT_STRING_MAX),
      ...(found.uxId ? { uxId: storableString(found.uxId, PATH_STRING_MAX) } : {}),
    })
  }
  return out
}
