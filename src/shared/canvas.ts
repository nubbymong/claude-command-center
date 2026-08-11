// Agent Canvas — shared contracts (spec: docs/agent-canvas-spec.md §4).
//
// P1 carries the version/serving subset only. Annotations, reviews, and the
// semantic-snapshot node types land with their phases (P2/P3) so this file
// never holds dead contracts.

/** Content types the canvas can host. P1 serves 'design' and 'uat'; 'plan' is P5. */
export type CanvasMode = 'uat' | 'design' | 'plan'

/** Every canvas operation is addressed explicitly — never inferred from ambient state (D9). */
export interface CanvasHandle {
  sessionId: string
  canvasId: string
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where a version's content comes from.
 * - 'uat': the project's BUILT static output. `distRoot` is an absolute path
 *   registered at render time; serving is read-only and traversal-checked.
 * - 'design': a standalone agent-authored HTML document, stored by the canvas
 *   store as a file on disk (the `html` string is accepted at render time and
 *   never round-trips through version metadata).
 */
export type CanvasVersionSource =
  | { mode: 'uat'; distRoot: string; entry: string; buildLabel?: string }
  | { mode: 'design'; entry: string }

/** One rendered version. Ids are 'v1', 'v2', … — monotonic, linear (D11). */
export interface CanvasVersion {
  id: string
  mode: CanvasMode
  createdAt: string
  source: CanvasVersionSource
  restoredFrom?: string
}

/** What the renderer holds per session (IPC `canvas:getState` result). */
export interface CanvasState {
  canvasId: string
  sessionId: string
  activeVersionId: string | null
  versions: CanvasVersion[]
}

/** Payload of the `canvas:changed` main → renderer push. */
export interface CanvasChangedEvent {
  sessionId: string
  canvasId: string
  activeVersionId: string | null
}

/** Renderer → main render request (dev/test ingress; MCP `canvas_render` lands in P3). */
export type CanvasRenderSource =
  | { mode: 'design'; html: string }
  | { mode: 'uat'; distRoot: string; entry?: string; buildLabel?: string }

// ── ccc-ux:// URL shape ─────────────────────────────────────────────────────
// ccc-ux://<canvasId>/<versionId>/<path>  — the canvas id is the URL HOST so
// each canvas is its own origin (storage/SW scope cannot leak across sessions).

export const CCC_UX_SCHEME = 'ccc-ux'

/** Path (absolute within a canvas origin) the serve-time-injected bridge script is mounted at.
 *  Version-independent on purpose: an absolute src survives any document path. */
export const CANVAS_BRIDGE_PATH = '/__ccc__/canvas-bridge.js'

/** Ids that may appear in ccc-ux:// URLs. canvasId comes from randomId() (24
 *  lowercase hex); versionIds are 'v<n>'. The pattern is deliberately tighter
 *  than "path-safe" — these are the ONLY shapes the store ever mints. */
export const CANVAS_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const CANVAS_VERSION_ID_RE = /^v[0-9]{1,9}$/

export function canvasContentUrl(canvasId: string, versionId: string, entry: string): string {
  const cleanEntry = entry.replace(/^\/+/, '')
  return `${CCC_UX_SCHEME}://${canvasId}/${versionId}/${cleanEntry}`
}

// ── Bridge protocol (host ↔ content frame, postMessage) ─────────────────────
// The bridge is READ-ONLY from the content side: content reports; content is
// never commanded to draw or navigate (D8). Requests originate host-side with
// an id; content replies with the same id. Content also emits unsolicited
// 'ready' / 'viewport' / 'pointer' events.

export const CANVAS_BRIDGE_NS = 'ccc-canvas'

/** A node as the P1 bridge reports it (P2 replaces the role/name heuristics
 *  with dom-accessibility-api + aria-query and adds the full semantic pass). */
export interface CanvasHitInfo {
  role: string
  name: string
  tag: string
  uxId?: string
  /** Bounding box in CONTENT PAGE coordinates (document space, not viewport). */
  box: Rect
}

export interface CanvasViewportInfo {
  scrollX: number
  scrollY: number
  width: number
  height: number
  dpr: number
  /** visualViewport.scale — pinch zoom factor, 1 on desktop almost always. */
  scale: number
}

export type CanvasBridgeRequest =
  | { ns: typeof CANVAS_BRIDGE_NS; id: number; type: 'snapshot' }
  | { ns: typeof CANVAS_BRIDGE_NS; id: number; type: 'boxMap' }
  | { ns: typeof CANVAS_BRIDGE_NS; id: number; type: 'elementAtPoint'; x: number; y: number }

export interface CanvasSnapshotNode extends CanvasHitInfo {
  children: CanvasSnapshotNode[]
}

export type CanvasBridgeResponse =
  | { ns: typeof CANVAS_BRIDGE_NS; id: number; ok: true; result: unknown }
  | { ns: typeof CANVAS_BRIDGE_NS; id: number; ok: false; error: string }

export type CanvasBridgeEvent =
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'ready' }
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'viewport'; viewport: CanvasViewportInfo }
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'pointer'; pageX: number; pageY: number; hit: CanvasHitInfo | null }
