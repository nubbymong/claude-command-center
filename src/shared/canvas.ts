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

/** Path the analysis chunk (axe-core) is mounted at. It is an order of magnitude
 *  larger than the bridge, so it is NOT part of the always-injected script: the
 *  bridge pulls it in on the first snapshot that asks for issue analysis. */
export const CANVAS_ANALYSIS_PATH = '/__ccc__/canvas-analysis.js'

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

/** What a snapshot request may narrow. Both levers exist for token economy: an
 *  unscoped snapshot of a dense page is the expensive case the agent is told to
 *  avoid (spec §4.1, §5). */
export interface CanvasSnapshotOptions {
  /** `data-ux-id` values to scope to. Absent/empty = the whole document. Only
   *  scoped nodes carry `styles` — that is the bulk of the token cost. */
  scope?: string[]
  /** Run the axe pass, loading the analysis chunk on first use. Default true. */
  analysis?: boolean
}

export type CanvasBridgeRequest =
  | ({ ns: typeof CANVAS_BRIDGE_NS; id: number; type: 'snapshot' } & CanvasSnapshotOptions)
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

// ── Semantic snapshot (P2, spec §4) ─────────────────────────────────────────
// The richer tree the P2 bridge produces (dom-accessibility-api + aria-query +
// axe-core + a measurement pass) and the `canvas_snapshot` MCP tool returns.
// The P1 CanvasSnapshotNode above is the basic role/name/box report; SnapshotNode
// supersedes it once the bundled bridge lands.

/** One axe (or measurement) finding joined onto the node it fired on. */
export interface AxeIssue {
  rule: string
  severity: string
  /** What was measured on the page, e.g. '28px' or '2.47:1'. */
  measured: string
  /** What the rule needs, e.g. '44px' or '4.5:1'. */
  needed: string
}

export interface SnapshotNode {
  /** Stable within a single snapshot ('e12'). */
  ref: string
  uxId?: string
  role: string
  name: string
  /** Content-page coordinates at capture. */
  box: Rect
  /** Curated computed styles (font-*, color, background, padding, margin,
   *  overflow, …). Present only for nodes IN SCOPE — the dominant token cost,
   *  so unscoped snapshots omit them (spec §4.1). */
  styles?: Record<string, string>
  /** Form-state semantics — a HARD P2 requirement (P0 run-2b): a lossy tree on a
   *  form page produced false positives. Present on form controls. */
  state?: {
    type?: string
    checked?: boolean
    disabled?: boolean
    /** Redacted to '<redacted>' for password/hidden inputs and secret-looking
     *  fields — the snapshot is sent verbatim to the agent. */
    value?: string
    ariaInvalid?: boolean
    /** Effective (accumulated) opacity, 0..1 — catches "visible in the DOM but
     *  faded to nothing" that a bare tree misses. */
    opacity?: number
    /** Deliberately screen-reader-only (clip/1px/inset(50%)). The other HARD
     *  P0 run-2b requirement: without it the agent reports every visually-hidden
     *  label as an invisible-text defect. Suppresses size/clipping rules. */
    srOnly?: boolean
  }
  issues?: AxeIssue[]
  children: SnapshotNode[]
}

/** What the in-page bridge returns for a snapshot request. The main process
 *  stamps `versionId` / `capturedAt` onto this to make a `SemanticSnapshot` —
 *  neither is taken from the content frame. */
export interface CanvasSnapshotResult {
  viewport: { width: number; height: number; dpr: number }
  root: SnapshotNode
  /** Scope ids that matched nothing on the page. */
  unmatchedScope?: string[]
  /** The node cap was hit — the tree is partial. */
  truncated?: boolean
  /** Analysis was asked for but could not run (chunk blocked, axe threw). The
   *  snapshot is still returned; measurement issues are unaffected. */
  analysisError?: string
}

export interface SemanticSnapshot {
  versionId: string
  /** ISO capture time. */
  capturedAt: string
  viewport: { width: number; height: number; dpr: number }
  root: SnapshotNode
}
