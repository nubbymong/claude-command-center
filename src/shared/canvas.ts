// Agent Canvas — shared contracts (spec: docs/agent-canvas-spec.md §4).
//
// P1 carried the version/serving subset; P2 added the semantic snapshot; P3
// adds anchoring, annotations, and reviews. Plan-mode pieces ('plan-step'
// anchors, verdicts) are typed here because the CONTRACT is one union — but
// nothing renders them until P5.

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

/** Renderer → main render request (dev/test ingress; the `canvas_render` MCP
 *  tool is the agent-facing ingress — both land in the store's renderVersion). */
export type CanvasRenderSource =
  | { mode: 'design'; html: string }
  | { mode: 'uat'; distRoot: string; entry?: string; buildLabel?: string }

// ── Anchoring (P3, spec §4) ─────────────────────────────────────────────────

/**
 * How an annotation points at content across re-renders.
 *
 * 'ux-id' is primary for uat/design (the authoring contract's `data-ux-id`);
 * 'plan-step' is primary for plan mode (P5); 'fingerprint' is a FALLBACK only —
 * the name in it is a weak signal. One element commonly carries two refs: its
 * ux-id and, captured at the same moment, its fingerprint. Resolution walks the
 * list in order and stops at the first hit, which is what makes "ux-id lookup →
 * fingerprint fallback" one loop rather than two code paths.
 */
export type AnchorRef =
  | { kind: 'ux-id'; id: string }
  | { kind: 'plan-step'; id: string }
  | { kind: 'fingerprint'; role: string; name: string; ancestorPath: string; ordinal: number }

/**
 * What a locked selection or a marquee IS, once the user has one.
 *
 * `bboxPage` is content-page coords AT CAPTURE — on a later version it is the
 * ghost box the resolution checklist shows when nothing re-anchors, so it must
 * survive the element it described. `targets` is empty for a pure region.
 */
export interface FocusObject {
  targets: AnchorRef[]
  bboxPage: Rect
  /** Human-readable ('button "Save"' / 'region 420×180'). Page-derived text —
   *  render it as data, never as markup or operator voice. */
  label: string
  versionId: string
}

// ── Annotations & reviews (P3, spec §4) ─────────────────────────────────────

export type AnnotationScope = 'element' | 'region' | 'general'
export type AnnotationState = 'open' | 'approved' | 'reannotated' | 'dismissed'
export type PlanVerdict = 'accept' | 'reject' | 'question'

/** A sketch attached to a note (D6). The glass is never the data model: this
 *  RECORD references glass elements; the PNG is exported once, at submit. */
export interface AnnotationSketch {
  excalidrawElementIds: string[]
  /** Relative to the canvas's own directory ('reviews/R3/a7.png'), so a moved
   *  resources dir does not orphan every attachment. Empty until submit. */
  pngPath: string
  bboxPage: Rect
}

export interface Annotation {
  /** 'a1', 'a2', … — minted by the store, never accepted from a caller. */
  id: string
  reviewId: string
  /** 'general' has no focus and can never orphan. */
  scope: AnnotationScope
  note: string
  /** Plan mode only (P5). */
  verdict?: PlanVerdict
  /** Element/region only. */
  focus?: FocusObject
  sketch?: AnnotationSketch
  /** The version the note was made against (a draft review can span versions;
   *  each note remembers its own). */
  versionId: string
  state: AnnotationState
  /** Id of the re-annotation that replaced this note (state 'reannotated'). */
  supersededBy?: string
}

export interface Review {
  /** 'R7' — rendered as 'Review #7'. Minted by the store. */
  id: string
  canvas: CanvasHandle
  /** The active version at submit time (D12: resolution runs against the
   *  agent's FINAL render of its turn, one pass per turn). */
  versionId: string
  annotationIds: string[]
  status: 'draft' | 'submitted' | 'resolved'
  createdAt: string
  submittedAt?: string
}

/** What `canvas_review` returns to the agent (the pull side of D10). */
export interface ReviewPayload {
  review: Review
  /** Element/region notes; `snapshotContext` is a scoped subtree when one was
   *  captured with the note (optional — absent in v1). */
  annotations: Array<Annotation & { snapshotContext?: SnapshotNode }>
  generalNotes: Annotation[]
  /** Sketch PNGs, served to the agent as images alongside the text. */
  attachments: Array<{ annotationId: string; pngPath: string }>
  envelope: 'untrusted-content'
}

/** Ids the review store mints. Tighter than path-safe on purpose (these appear
 *  in file names under the canvas dir): the store never mints anything else. */
export const CANVAS_REVIEW_ID_RE = /^R[0-9]{1,9}$/
export const CANVAS_ANNOTATION_ID_RE = /^a[0-9]{1,9}$/

/** What the renderer holds per session for reviews (IPC `canvas:reviewGetState`). */
export interface CanvasReviewState {
  canvasId: string
  sessionId: string
  reviews: Review[]
  annotations: Annotation[]
}

/** Payload of the `canvas:reviewChanged` main → renderer push. */
export interface CanvasReviewChangedEvent {
  sessionId: string
  canvasId: string
}

/**
 * Renderer → main: create or update a note in the session's draft review.
 * Ids are minted in main; a draft carries `annotationId` only to UPDATE the
 * note it names, and only while that note's review is still a draft.
 */
export interface CanvasAnnotationDraft {
  annotationId?: string
  scope: AnnotationScope
  note: string
  focus?: FocusObject
  /** Sketch metadata only (ids + bbox). The PNG is exported at submit (D6). */
  sketch?: { excalidrawElementIds: string[]; bboxPage: Rect }
  versionId: string
}

/** Renderer → main at submit: one exported PNG per sketch-carrying note. */
export interface CanvasSketchExport {
  annotationId: string
  /** Base64 PNG (no data: prefix). Capped by schema and re-checked in main. */
  pngBase64: string
}

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

/** The origin a canvas's documents serialize to — the exact target the host uses
 *  when posting INTO the frame, so a request can never be delivered to a
 *  document other than that canvas's own. */
export function canvasOrigin(canvasId: string): string {
  return `${CCC_UX_SCHEME}://${canvasId}`
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
  | { ns: typeof CANVAS_BRIDGE_NS; id: number; type: 'inspect'; x: number; y: number }
  | { ns: typeof CANVAS_BRIDGE_NS; id: number; type: 'resolveAnchors'; anchors: AnchorRef[] }

export interface CanvasSnapshotNode extends CanvasHitInfo {
  children: CanvasSnapshotNode[]
}

/**
 * The identity an element can be re-found by once its box is stale (spec §4
 * fingerprint anchor). Computed content-side, where the whole document is in
 * reach; the host only stores and replays it.
 */
export interface CanvasFingerprint {
  role: string
  name: string
  /** role-or-tag of each meaningful ancestor, outermost first ('main>list>listitem'). */
  ancestorPath: string
  /** Position among the document's elements sharing role+name+ancestorPath, in
   *  document order — the tie-breaker when a page repeats a component. */
  ordinal: number
}

export interface CanvasInspectEntry extends CanvasHitInfo {
  fingerprint: CanvasFingerprint
}

/** Reply to 'inspect': the meaningful chain at a point, deepest-first, so
 *  "expand to parent" is a walk up this array with no further round-trips. */
export interface CanvasInspectResult {
  chain: CanvasInspectEntry[]
}

/** How far up an inspect chain goes. Enough for any real selection ladder;
 *  bounds what a hostile page can make the host hold per click. */
export const MAX_INSPECT_CHAIN = 12

/** Reply entries for 'resolveAnchors', 1:1 with the request's anchors. */
export type CanvasAnchorResolution =
  | { found: true; via: 'ux-id' | 'fingerprint'; box: Rect; role: string; name: string; uxId?: string }
  | { found: false }

export interface CanvasResolveAnchorsResult {
  results: CanvasAnchorResolution[]
}

/** Cap on anchors per resolveAnchors request (open notes × ~2 refs each; far
 *  beyond any real checklist, small enough to bound the content-side scan). */
export const MAX_RESOLVE_ANCHORS = 120

export type CanvasBridgeResponse =
  | { ns: typeof CANVAS_BRIDGE_NS; id: number; ok: true; result: unknown }
  | { ns: typeof CANVAS_BRIDGE_NS; id: number; ok: false; error: string }

/**
 * Keys the bridge REPORTS from inside the content frame ('contentKey').
 *
 * A closed allowlist, and only ever reported from a non-editable target: in
 * browse mode the iframe owns keyboard focus, so the host would never hear the
 * spec's "one key expands to parent" without the content relaying it — but a
 * page is full of real inputs, and relaying keystrokes from THOSE would be a
 * keylogger wearing a feature's name. Two navigation keys, nothing else, and
 * the host treats them as requests it may ignore (a report, per D8 — the
 * content is never commanded).
 */
export const CANVAS_REPORTED_KEYS = ['Escape', 'ArrowUp'] as const

export type CanvasBridgeEvent =
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'ready' }
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'viewport'; viewport: CanvasViewportInfo }
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'pointer'; pageX: number; pageY: number; hit: CanvasHitInfo | null }
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'contentClick'; pageX: number; pageY: number; hit: CanvasHitInfo | null }
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'contentKey'; key: string }

// ── Semantic snapshot (P2, spec §4) ─────────────────────────────────────────
// The richer tree the P2 bridge produces (dom-accessibility-api + aria-query +
// axe-core + a measurement pass) and the `canvas_snapshot` MCP tool returns.
// The P1 CanvasSnapshotNode above is the basic role/name/box report; SnapshotNode
// supersedes it once the bundled bridge lands.

/**
 * The only style properties a snapshot may carry.
 *
 * An ALLOWLIST, and it has to be one. The wire format spells a style as
 * `[name=value]` — the same shape, and the same `[a-z-]` alphabet, as every
 * structural token the format has. Accepting any key that merely LOOKED like a
 * CSS property therefore handed a page a token opener: on a scoped capture it
 * could emit `[ref=e1]` on a node that is not e1, plus `[sr-only=true]`,
 * `[disabled=true]` and a second `[value="…"]` — defeating by name the
 * guarantee that refs are assigned here and never accepted.
 *
 * Shared rather than duplicated because the producer (the in-page bridge) and
 * the boundary that accepts its reply are different files, and this codebase's
 * most expensive bug was two cleaners that had to agree while only one was
 * hardened.
 */
export const CURATED_STYLE_PROPERTIES = [
  'display',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'color',
  'background-color',
  'background-image',
  'padding',
  'margin',
  'overflow',
] as const

/**
 * How many findings one node may carry on the wire.
 *
 * Shared for the same reason CURATED_STYLE_PROPERTIES is: the producer (the
 * in-page bridge) trims to it and the boundary that accepts the reply enforces
 * it again, and this codebase's most expensive bug was two halves of one rule
 * that had to agree while only one was maintained.
 */
export const MAX_ISSUES_PER_NODE = 20

/**
 * The rule id that says findings were dropped from this node.
 *
 * MINTED at the trust boundary, never accepted from the frame — the same
 * assigned-not-accepted rule `ref` follows. The bridge reports a COUNT
 * (`SnapshotNode.issuesDropped`, a number the sanitiser re-validates); the words
 * are ours.
 */
export const ISSUES_TRUNCATED_RULE = 'issues-truncated'

/**
 * axe's `impact` vocabulary, ranked. Anything outside it is unranked and is
 * what a cap eats first.
 *
 * A Map, not an object literal — and the two other lookup tables in this
 * pipeline (`ALLOWED_STYLE_PROPERTIES`, `ANALYSIS_CODES`) are Sets for the same
 * reason. `severity` is page-authored, so an object literal answers
 * `rank('toString')` with a FUNCTION: `Record<string, number>` makes TypeScript
 * believe the result is a number, the comparator's subtraction becomes NaN,
 * `NaN || a - b` falls through to positional order, and a genuine `critical`
 * finding is evicted from the wire by nineteen `minor` ones. Measured on the
 * shipped code with `severity: 'toString'`.
 */
const SEVERITY_RANK: ReadonlyMap<string, number> = new Map([
  ['critical', 4],
  ['serious', 3],
  ['moderate', 2],
  ['minor', 1],
])

/**
 * Where a finding sits in the queue when something has to go.
 *
 * Total by construction: every path returns one of the five numbers, so no
 * caller can be handed something that is not comparable.
 *
 * Normalises first, because the value is ranked HERE on a raw page record and
 * emitted LATER through `str`/`token`, both of which NFKC-fold — so a fullwidth
 * `ｃｒｉｔｉｃａｌ` ranked zero and printed `critical`. Two things that must
 * agree with only one of them maintained is the recurring bug in this pipeline;
 * bounded to 32 units first so normalising cannot itself become the cost.
 */
export function severityRank(severity: unknown): number {
  if (typeof severity !== 'string' || severity.length === 0 || severity.length > 32) return 0
  return SEVERITY_RANK.get(severity.normalize('NFKC')) ?? 0
}

/**
 * Which entries survive a cap: the `max` highest-ranked, ties broken by
 * position.
 *
 * Returns `null` when nothing has to go, so the common path allocates nothing.
 * Takes a rank FUNCTION rather than the values themselves because the two
 * callers hold different things — the bridge has built `AxeIssue`s, the
 * sanitiser has raw page records it has not paid to build yet and must not
 * (building 160 issues per node to keep 20 is the per-node cost that froze the
 * UI thread one field over).
 *
 * Selection is by severity; ORDER is not touched. The wire format is read top
 * to bottom by a model and a stable order is what makes two snapshots
 * comparable — so what changes is which findings survive, never where they sit.
 */
export function keepMostSevere(count: number, rankAt: (index: number) => number, max: number): Set<number> | null {
  if (max <= 0) return new Set()
  if (count <= max) return null
  const order = Array.from({ length: count }, (_, i) => i)
  order.sort((a, b) => rankAt(b) - rankAt(a) || a - b)
  return new Set(order.slice(0, max))
}

/** One axe (or measurement) finding joined onto the node it fired on. */
export interface AxeIssue {
  rule: string
  severity: string
  /** What was measured on the page, e.g. '28px' or '2.47:1'. */
  measured: string
  /** What the rule needs, e.g. '44px' or '4.5:1'. */
  needed: string
  /**
   * Where the problem actually is, when that is not the node carrying it.
   *
   * A finding fires on whichever element owns the text, and the snapshot emits
   * only the nodes it considers meaningful — so a finding on a plain wrapper is
   * attributed to the nearest emitted ancestor, up to six hops up. Without this
   * the agent is told "`main` has a contrast problem" and has nowhere to go.
   * Absent when the finding is on the node itself.
   */
  at?: Rect
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
    /**
     * How many characters the field holds. NOT what it holds.
     *
     * A snapshot goes verbatim into the model's context and from there into
     * transcripts, so a field's contents are the highest-consequence thing in
     * it. Deciding WHICH fields are secret means recognising every way a human
     * might name one, across languages, spellings and separators — two rounds
     * of adversarial review found that heuristic first too broad and then too
     * narrow, and both were right. So the contents are simply never carried.
     *
     * A review still gets what it needs from the structure: the label, the
     * placeholder and the accessible name are all page-authored TEXT and are
     * emitted in full as the node's `name`. What is withheld is only what the
     * USER typed — and the length of it, which is what overflow and truncation
     * review actually needs. Omitted when the field is empty.
     */
    valueLength?: number
    ariaInvalid?: boolean
    /**
     * `inert` on this element or an ancestor.
     *
     * Carried because it SUPPRESSES: `inert` removes a subtree from interaction
     * and from the accessibility tree, so contrast findings on it are correctly
     * withheld — and a withheld finding that nothing records is
     * indistinguishable from no finding. It was the last exemption in the
     * measurement pass that left no trace at all; the `aria-disabled` family at
     * least emits `[disabled]`. One attribute on one wrapper, and every defect
     * beneath it vanished silently.
     */
    inert?: boolean
    /** Effective (accumulated) opacity, 0..1 — catches "visible in the DOM but
     *  faded to nothing" that a bare tree misses. */
    opacity?: number
    /** Deliberately screen-reader-only (clip/1px/inset(50%)). The other HARD
     *  P0 run-2b requirement: without it the agent reports every visually-hidden
     *  label as an invisible-text defect. Suppresses size/clipping rules. */
    srOnly?: boolean
  }
  issues?: AxeIssue[]
  /**
   * How many findings this node had that did not fit — a LOWER bound.
   *
   * A number rather than a sentence, because it crosses the trust boundary: the
   * sanitiser validates it as a non-negative integer and mints the wire text
   * itself (ISSUES_TRUNCATED_RULE), so nothing page-authored rides in on it.
   *
   * A lower bound because the overlap pass stops scanning once it has filled its
   * share, and stopping is what keeps a degenerate page from spending the whole
   * comparison budget on its first node. Every other producer counts exactly.
   */
  issuesDropped?: number
  children: SnapshotNode[]
}

// ── Snapshot capture over IPC (main ↔ renderer ↔ content frame) ─────────────
// The snapshot is produced INSIDE the content frame, so the MCP tool (main) has
// to ask the renderer, which asks the frame. Both hops are id-correlated; main
// never trusts what comes back (see canvas-snapshot-sanitize.ts).

/** main → renderer: take a snapshot of the live frame for this canvas. */
export interface CanvasSnapshotRequestEvent {
  requestId: string
  sessionId: string
  canvasId: string
  versionId: string
  options: CanvasSnapshotOptions
}

/** renderer → main: the answer, or why there isn't one. */
export type CanvasSnapshotReply =
  | { requestId: string; ok: true; result: CanvasSnapshotResult }
  | { requestId: string; ok: false; error: string }

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
  /**
   * The walk refused an element deeper than its depth cap, so there is DOM
   * below it that was not looked at.
   *
   * SEPARATE from `truncated`, deliberately. `truncated` means nodes were
   * dropped and reads to the agent as "the page exceeded the node limit"; a
   * page can nest past 64 levels — routine once providers, portals and layout
   * wrappers stack up — without losing a single node. Reporting the wrong limit
   * costs a whole second capture, and unlike the node cap this one has an
   * answer: scope to a `data-ux-id` inside the deep region and the walk
   * restarts from there.
   */
  depthLimited?: boolean
  /**
   * Something on the page paints a box and offers no tree to read.
   *
   * A CLOSED shadow root is the case that produces it: `shadowRoot` is null for
   * one exactly as it is for an element that has none, so the content cannot be
   * reached by any means a page script has. An OPEN root is walked and needs no
   * flag.
   *
   * Its own bit rather than `truncated`, for the reason `depthLimited` is its
   * own bit: the three have different answers. Nothing scopes past this one and
   * no second capture helps — the honest report is that a region of the page was
   * not reviewed and cannot be.
   */
  hiddenContent?: boolean
  /**
   * The overlap rule stopped looking at some node before it ran out of
   * neighbours to look at.
   *
   * Two per-node budgets bound that rule, and both were silent: a node that
   * exhausted one reported "no overlap" in exactly the same words as a node
   * that genuinely has none. A page can reach either by accident — an icon grid
   * or a long list inside one card puts hundreds of boxes in one horizontal
   * band — and a hostile one reaches it on purpose with decoys.
   *
   * Its own bit rather than the node's `issuesDropped`, and the distinction is
   * the one that bit a previous round: declaring a DROP reserves a slot on the
   * wire for a finding that was lost, so declaring one that may not have
   * happened evicts a real finding to make room for the announcement. Nothing
   * here was necessarily lost. What is certainly true — and all this claims —
   * is that boxes went uncompared.
   *
   * Answerable, like `depthLimited`: the budgets are per node and spent on the
   * candidates around it, so a scoped capture spends fewer of them.
   */
  overlapLimited?: boolean
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
