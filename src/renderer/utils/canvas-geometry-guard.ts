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

import type { CanvasHitInfo, CanvasViewportInfo, Rect } from '../../shared/canvas'

const HIT_STRING_MAX = 120

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
