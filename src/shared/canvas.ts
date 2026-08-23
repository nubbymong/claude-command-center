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
  /** A DRAFT: the agent is still reviewing its own work (#366). Invisible to
   *  the user — the pane keeps showing the last ready version, nothing pulses
   *  or counts — and the next draft render SUPERSEDES it in place rather than
   *  appending. Absent = ready (every version written before this field). */
  draft?: true
}

/** The round the user owes a first review on: set when the agent deliberately
 *  marks a render ready (#366), cleared when the user submits a review on the
 *  canvas. This is one of the two inputs to the queue number (#364); the other
 *  is rounds awaiting the user's verdicts, derived from the review store. */
export interface CanvasAwaitingReview {
  versionId: string
  at: string
}

/** What the renderer holds per session (IPC `canvas:getState` result). */
export interface CanvasState {
  canvasId: string
  sessionId: string
  activeVersionId: string | null
  versions: CanvasVersion[]
  /** What this canvas is OF, in the agent's own words — "Title bar logo
   *  placement", "Checkout flow". Label only: sanitized in main, shown to the
   *  user, and never a key for serving or authorizing anything. */
  title?: string
  /** Present while a ready-marked render awaits the user's first review. */
  awaitingReview?: CanvasAwaitingReview
}

/** Longest canvas title kept. A title names a subject; it is not a description. */
export const MAX_CANVAS_TITLE_CHARS = 80

/** Payload of the `canvas:changed` main → renderer push. */
export interface CanvasChangedEvent {
  sessionId: string
  canvasId: string
  activeVersionId: string | null
  /** True when this change is a DRAFT render (#366): the mirrors refresh, but
   *  nothing may surface to the user — no pulse, no count, no pane switch. */
  draft?: boolean
}

/** Renderer → main render request (dev/test ingress; the `canvas_render` MCP
 *  tool is the agent-facing ingress — both land in the store's renderVersion).
 *
 *  `title` names the SUBJECT. A canvas holds one subject and accumulates
 *  versions of it; naming a different subject files the old canvas and starts a
 *  new one, so a fresh topic never inherits the previous topic's versions or
 *  its unresolved review notes. See renderVersion. */
export type CanvasRenderSource =
  | { mode: 'design'; html: string; title?: string; ready?: boolean }
  | { mode: 'plan'; html: string; title?: string; ready?: boolean }
  | { mode: 'uat'; distRoot: string; entry?: string; buildLabel?: string; title?: string; ready?: boolean }

/**
 * The `ready` flag (#366), three-valued on purpose:
 * - `false`: a DRAFT — the agent is still checking its own work. Nothing
 *   surfaces; a draft supersedes the previous draft in place.
 * - `true`: the deliberate ready-mark. The latest draft is promoted (or a new
 *   ready version appended), the round enters the review queue, and the
 *   agent's turn ends.
 * - absent: a render from a flow that has not learned the flag. Behaves as
 *   every render did before drafts existed — it surfaces immediately AND
 *   counts as ready, so an old-style agent's hand-off is never invisible.
 */

/**
 * A plan version is STORED AND SERVED exactly as a design version: an
 * agent-authored standalone document in the version's own directory, read-only,
 * same traversal checks, same bridge. Its `source` therefore says `'design'`
 * and only `CanvasVersion.mode` says `'plan'`.
 *
 * That split is the whole of plan mode, and it is deliberate. `mode` is WHAT THE
 * PAGE IS -- it drives the chip in the pane header and tells the agent which
 * authoring skill wrote it. `source` is HOW IT IS STORED AND SERVED. Keeping
 * them apart means plan mode adds no branch to any serving or validation path,
 * so the surface an attacker can reach is byte-for-byte the one design mode
 * already had. A third mode later (a migration, an incident timeline) costs a
 * skill and a chip and nothing else.
 *
 * The invariant, in one line: `version.source.mode` is 'design' | 'uat' and is
 * the ONLY thing serving looks at; `version.mode` is 'design' | 'plan' | 'uat'
 * and is only ever a label.
 */

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
/**
 * `open` is the only state a note is born in. The user moves it to `approved`,
 * `dismissed`, `stale` or `reannotated` from the panel. `addressed` is the
 * AGENT's: "I acted on this note" — set through canvas_resolve after the agent
 * has done the work, so a review the user finishes in chat rather than in the
 * panel does not sit as five open notes forever. It is deliberately not
 * `approved`: approval is the user's word, and the agent never speaks it for
 * them.
 *
 * `stale` is the CLOSE-OUT state: the work this note was about has SHIPPED, so
 * the note is no longer live — and nobody is claiming it was reviewed and found
 * good. That distinction is the whole reason for a sixth state rather than
 * reusing `approved`: "this went out" and "I looked and it is right" are
 * different facts, and only the second is the user's verdict to give.
 *
 * `approved` is the one state NO tool can write. Enforced in the review store
 * (`closeAnnotationsByAgent`), not merely described in a tool schema — a tool
 * description is a request, and MCP arguments are model-generated.
 */
export type AnnotationState = 'open' | 'addressed' | 'approved' | 'reannotated' | 'dismissed' | 'stale'
export type PlanVerdict = 'accept' | 'reject' | 'question'

/**
 * The two terminal states an AGENT may set, and then only on the user's
 * explicit instruction (the `canvas_verdict` tool).
 *
 * A frozen list rather than a bare type union, because the check enforcing it
 * has to exist at RUNTIME: the value arrives from a model-generated MCP tool
 * call, and a TypeScript union is not a boundary. `approved` is deliberately,
 * permanently absent — approval stays a click only the user can make.
 */
export const AGENT_CLOSE_VERDICTS = ['stale', 'dismissed'] as const
export type AgentCloseVerdict = (typeof AGENT_CLOSE_VERDICTS)[number]

/** Who moved a note to a terminal state. `agent` means `canvas_verdict` wrote
 *  it on the user's instruction — which the panel says out loud, and lists
 *  apart from the user's own approvals. */
export type AnnotationClosedBy = 'user' | 'agent'

/**
 * Who moved a note into `addressed` — the state the agent's close-out
 * precondition is entirely made of.
 *
 * Only 'agent' is reachable today (`canvas_resolve` is the single writer of
 * that state), and that is exactly the point: the close-out barrier has to be
 * able to READ the fact rather than assume it, so that if a user-side "mark
 * addressed" ever exists the barrier treats it correctly instead of inheriting
 * a hole from an assumption nobody re-checked.
 */
export type AnnotationAddressedActor = 'agent' | 'user'

/** The provenance of one open -> addressed transition. */
export interface AddressedBy {
  actor: AnnotationAddressedActor
  /** The session that made the write. `canvas_verdict` compares it against its
   *  own session so the record can say "you addressed these yourself" rather
   *  than the vaguer "somebody did". */
  sessionId: string
}

/** A sketch attached to a note (D6). The glass is never the data model: this
 *  RECORD references glass elements; the PNG is exported once, at submit. */
export interface AnnotationSketch {
  excalidrawElementIds: string[]
  /** Relative to the canvas's own directory ('reviews/R3/a7.png'), so a moved
   *  resources dir does not orphan every attachment. Empty until submit. */
  pngPath: string
  bboxPage: Rect
}

/** One alternative the agent attached when it ADDRESSED a note (#373): "I did
 *  it three ways — pick which ships". Keys are minted by the store from
 *  position ('A'…'D'), never accepted from the agent; the label is agent
 *  prose, held to the same cleanliness rules as a note. */
export interface AnnotationVariant {
  key: string
  label: string
}

/** Most alternatives one note may carry — A through D. */
export const MAX_ANNOTATION_VARIANTS = 4

/** Longest variant label kept. A label names an alternative; it is not the
 *  explanation (that belongs in the version itself). */
export const MAX_VARIANT_LABEL_CHARS = 80

/**
 * The one shape a variant label may have, enforced at BOTH ingresses (the MCP
 * tool and the store) and again by the file validator.
 *
 * Stricter than a note on purpose. A note is the user's multi-line prose; a
 * label is agent-authored text that becomes (a) a chip the USER clicks and
 * (b) a single serializer FIELD (`variants: A=…`) the agent reads back beside
 * `chosen-variant:` — the line that carries the user's decision. A newline in
 * a label would let the agent forge that line onto a note nobody approved, so
 * every control character is banned (tab and newline included), along with the
 * bidi overrides and zero-width characters that could make a chip read
 * differently than it acts.
 */
export function isCleanVariantLabel(label: unknown): label is string {
  if (typeof label !== 'string') return false
  if (label.trim().length === 0 || label.length > MAX_VARIANT_LABEL_CHARS) return false
  // C0 + DEL + C1 controls — tab, newline, and carriage return among them.
  if (/[\u0000-\u001F\u007F-\u009F]/.test(label)) return false
  // Every invisible FORMAT character as a property, not a spelling list \u2014 bidi
  // overrides, the zero-width family, BOM, ALM, the tag block \u2014 plus the line
  // and paragraph separators (category Z, so outside Cf). A denylist here
  // would repeat the chase-the-spelling mistake the untrusted envelope already
  // paid for. Composite emoji (ZWJ sequences) lose too; a label is a name, not
  // a place for glue characters.
  if (/[\p{Cf}\u2028\u2029]/u.test(label)) return false
  return true
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
  /**
   * The alternatives the agent attached when addressing this note (#373).
   * Present only alongside an agent address; replaced whole on a re-address;
   * cleared when the note goes back to 'open'. Display data plus one choice —
   * they change no state machine.
   */
  variants?: AnnotationVariant[]
  /**
   * The variant the USER approved (#373). Only the user's own Approve can set
   * it — it rides the same IPC the verdict does, and no tool can write it —
   * and it only ever names a key that exists in `variants`. Cleared on reopen.
   */
  chosenVariantKey?: string
  /** Id of the re-annotation that replaced this note (state 'reannotated'). */
  supersededBy?: string
  /**
   * Who moved this note to its terminal state. Absent on a live note, and
   * absent on records written before close-out existed.
   *
   * The panel needs it because `stale` and `dismissed` are reachable from both
   * sides: the user clicking "Accept as built", and the agent calling
   * `canvas_verdict` on the user's word. Those read very differently to the
   * person who has to trust the list, so the row says which one happened.
   * `approved` is always the user's — no tool can write it — so this field can
   * never be 'agent' beside that state.
   */
  closedBy?: AnnotationClosedBy
  /**
   * The state this note held when it was closed, so REOPEN can put it back
   * exactly where it was rather than guessing.
   *
   * Without it, reopening has to pick one: send it back to 'open' (telling the
   * agent to do work it already did) or to 'addressed' (claiming the agent
   * acted when it may never have). Both are wrong some of the time, and the
   * record already knew the answer at the moment it was closed.
   */
  closedFrom?: 'open' | 'addressed'
  /**
   * When the AGENT marked this note addressed (`canvas_resolve`).
   *
   * Provenance for the panel and for anyone reading the record: the moment the
   * agent claimed to have acted. It is NOT what authorises a close — a delay is
   * not permission, and an unattended agent can wait — so the close-out barrier
   * reads `addressedBy`/`userSawAddressed` instead. See `closeAnnotationsByAgent`.
   *
   * Absent on a note nobody has addressed, and on records written before this.
   */
  addressedAt?: string
  /**
   * WHO moved this note into `addressed`, and from which session.
   *
   * Half of the close-out barrier. The agent's precondition for closing a round
   * ("every note on it is addressed") is a state the agent writes ITSELF, so on
   * its own it proves nothing: `canvas_resolve` then `canvas_verdict` satisfies
   * it in one unattended pass with no user anywhere in the chain. Recording the
   * actor is what lets the store refuse to let one party be both the hand that
   * created the precondition and the hand that spends it.
   *
   * Absent on records written before this — and absent is NOT a pass: a note
   * with no provenance is treated as agent-addressed, because the backlog this
   * feature exists to clear was all addressed by agents.
   */
  addressedBy?: AddressedBy
  /**
   * Whether the USER has actually seen this note in its addressed state.
   *
   * The other half of the barrier, and the only thing on this record an agent
   * cannot write. It is set from the renderer — and only when the note's
   * addressed state has been on the user's screen, in the active session, in a
   * visible window, long enough to read — never by any MCP tool, and never by
   * the main process on an agent's behalf.
   *
   * Cleared every time the note is re-addressed: seeing an OLD claim of work is
   * not seeing the new one.
   */
  userSawAddressed?: boolean
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
  /**
   * Ask the content to stop (or resume) emitting its unsolicited `pointer` and
   * `contentClick` events — x-ray Off (#367).
   *
   * The only request that is not a question, and it is worth being precise
   * about why it does not breach D8 ("content is never commanded to draw"): it
   * can only make the bridge QUIETER. No value of `enabled` makes the page
   * report more than it already would, draw anything, or change what it
   * renders. Off means the page does no per-mousemove work at all, which is
   * what "view it as a normal browser tab" has to mean to be worth having.
   *
   * It is not a security boundary in either direction. The bridge shares a
   * realm with the page and may ignore this, so the HOST gates on the same mode
   * (AgentCanvasPane's onPointer/onContentClick), and that gate is the one that
   * decides what reaches the review store.
   */
  | { ns: typeof CANVAS_BRIDGE_NS; id: number; type: 'hoverReporting'; enabled: boolean }

/** Reply to 'hoverReporting': what the bridge says it is now doing. Advisory —
 *  the host enforces the mode itself and never needs this to be true. */
export interface CanvasHoverReportingResult {
  enabled: boolean
}

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

/**
 * Zoom intents the bridge REPORTS from inside the content frame ('contentZoom',
 * #368).
 *
 * Ctrl+wheel and the Ctrl+= / Ctrl+- / Ctrl+0 chords are the browser's zoom
 * gesture, and in the pane they belong to the HOST — but while the pointer or
 * keyboard focus is on the content, those events land in the frame and the host
 * never sees them. So the bridge relays the INTENT ('in' / 'out' / 'reset'),
 * never raw deltas or key values: the host owns the ladder, the clamp and the
 * application, and treats each report as a request it may ignore (D8). The
 * worst a forgery achieves is stepping a clamped, visible, Ctrl+0-reversible
 * visual zoom.
 */
export const CANVAS_ZOOM_ACTIONS = ['in', 'out', 'reset'] as const
export type CanvasZoomAction = (typeof CANVAS_ZOOM_ACTIONS)[number]

export type CanvasBridgeEvent =
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'ready' }
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'viewport'; viewport: CanvasViewportInfo }
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'pointer'; pageX: number; pageY: number; hit: CanvasHitInfo | null }
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'contentClick'; pageX: number; pageY: number; hit: CanvasHitInfo | null }
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'contentKey'; key: string }
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'contentZoom'; action: CanvasZoomAction }

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
/**
 * One canvas from an earlier session that the user could reclaim, described
 * well enough for them to recognise it in the Canvas pane.
 *
 * The user picks; nothing is matched automatically. Two rounds of adversarial
 * review established that no identity the main process can infer (project
 * directory, conversation uuid, "is the owner still alive") is trustworthy
 * enough to move the user's private review notes between sessions on its own.
 */
export interface ReclaimableCanvas {
  canvasId: string
  versionCount: number
  lastRenderedAt: string
  /** The project it was rendered in — a LABEL, never an authorization key.
   *  Format/bidi control characters are stripped in main before it is sent. */
  cwd?: string
  /**
   * First 8 characters of the Claude conversation this canvas was last
   * rendered under — the thing that actually TELLS TWO CANVASES APART.
   *
   * Without it, two canvases from one project render identically on the card
   * (constant title, version count, timestamp, cwd), and a mis-click re-binds
   * another project's private review notes to this session — which the
   * pre-allowed `canvas_review` tool can then read. Absent when the canvas was
   * never rendered under a conversation the binder could name.
   */
  conversationShortId?: string
  /** Whether it matches the asking session's project, for ordering only. */
  sameProject?: boolean
}

/**
 * One row of the canvas LIBRARY — every canvas on this machine, not just the
 * ones the asking session could reclaim.
 *
 * The library exists because nothing was ever removable: `renderVersion` only
 * ever appends, and no code path deleted a canvas or a version, so every canvas
 * a user had ever rendered accumulated forever and surfaced in the reclaim list
 * of every new session. That is a housekeeping surface, NOT an authorization
 * one — listing a canvas here never binds it to a session (that is still
 * `adoptCanvasForSession`, which the user drives). Everything on this row is a
 * LABEL, sanitized in main, and none of it may be used as a key for serving
 * content.
 */
export interface CanvasLibraryEntry {
  canvasId: string
  versionCount: number
  createdAt: string
  lastRenderedAt: string
  /** What the canvas is OF. The row's headline when present — an id and a
   *  timestamp do not tell anyone which canvas they are about to delete. */
  title?: string
  /** Project it was last rendered in. Label only; control characters stripped. */
  cwd?: string
  /** First 8 chars of the conversation it was last rendered under. Label only. */
  conversationShortId?: string
  /** Mode of its most recent version, so a mockup is tellable from a UAT run. */
  latestMode?: 'design' | 'uat'
  /** True when the session that owns it is one of the currently-open tiles — the
   *  UI warns before deleting a canvas that is on screen right now. */
  ownedByOpenSession?: boolean
  /** True when the ASKING session owns this canvas. DISPLAY ONLY — the in-pane
   *  switcher offers only your own canvases, while the library shows the whole
   *  project. It grants nothing: ownership is decided by adoptCanvasForSession,
   *  and delete takes an id with no ownership check at the IPC seam. */
  ownedByThisSession?: boolean
  /** True when this is the one canvas the asking session is currently showing.
   *  A session OWNS many and points at one, so this is a separate question. */
  isActiveForThisSession?: boolean
  /** What is outstanding on this canvas: submitted reviews with notes still in
   *  play, and unsubmitted notes. `undefined` means the review store could not
   *  be read — deliberately not 0, so a broken store never renders as "clear". */
  openReviewCount?: number
  draftNoteCount?: number
  /**
   * How many notes a bulk close-out on this row would ACTUALLY clear.
   *
   * Not "addressed notes on this canvas", which is a different and larger
   * number: the close-out skips any round still holding an open note, so on a
   * partial round (one note handled, one not) there are addressed notes and
   * nothing closeable. Labelling the button from the larger number promised
   * work it would not do and left a control that never went away.
   *
   * `undefined` for an unreadable store, exactly like the two above: the
   * library must never offer "close 0 notes" when the truth is "could not tell".
   */
  closeableNoteCount?: number
  /** A ready-marked render on this canvas awaits the user's first review
   *  (#366). From the canvas record, so it is always present when true. */
  awaitingReview?: boolean
  awaitingReviewAt?: string
  /** Rounds on this canvas waiting on the USER's verdicts — submitted reviews
   *  where every remaining note is addressed (#364). `undefined` when the
   *  review store could not be read, same rule as openReviewCount. */
  verdictRounds?: number
}

export interface CanvasSnapshotRequestEvent {
  requestId: string
  sessionId: string
  canvasId: string
  versionId: string
  /** The version's servable entry file (store-authored, from the version
   *  record). Lets the renderer lay the page out in a hidden frame when the
   *  pane is not open on this canvas+version (headless capture). */
  entry: string
  options: CanvasSnapshotOptions
}

/** renderer → main: the answer, or why there isn't one. */
export type CanvasSnapshotReply =
  | {
      requestId: string
      ok: true
      result: CanvasSnapshotResult
      /** True when the page was laid out in a hidden off-screen frame rather
       *  than captured from the pane the user is looking at. */
      headless?: boolean
    }
  | { requestId: string; ok: false; error: string }

/** What the in-page bridge returns for a snapshot request. The main process
 *  stamps `versionId` / `capturedAt` onto this to make a `SemanticSnapshot` —
 *  neither is taken from the content frame. */
export interface CanvasSnapshotResult {
  viewport: { width: number; height: number; dpr: number }
  root: SnapshotNode
  /** Renderer-host-authored (never the page's): this capture came from a
   *  hidden off-screen frame, not the pane the user has open. The broker
   *  stamps it from the reply envelope after sanitisation. */
  headless?: boolean
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
