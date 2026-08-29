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

// ── Audit stamps (M4) ───────────────────────────────────────────────────────
//
// WHO did this, and WHEN — carried on the canvas record, on each version, and
// on each note, so a shared project Library can say "cfg Checkout · Personal ·
// 2 days ago" instead of an opaque row.
//
// `sessionLabel` and `account` are DISPLAY METADATA ONLY. They are never keys
// and never gates: ownership is `CanvasState.sessionId`, liveness is main's own
// session registry, and the project is `cwd`. Making an account name part of
// any decision is exactly what ADR-017 removed. They exist so the user can tell
// two rows apart, nothing more — which is also why they are cleaned and capped
// here rather than trusted from whatever produced them.

/** Longest display label an audit stamp keeps. A label names a thing; it is
 *  not a description, and it shares one mono line with three other fields. */
export const MAX_AUDIT_LABEL_CHARS = 80

/** Longest stamp id/timestamp kept — the bound every other stored stamp in this
 *  contract carries. */
const MAX_AUDIT_ID_CHARS = 128
const MAX_AUDIT_TIME_CHARS = 64

/** Session ids are app-minted (randomId → 24 hex); the bound is defensive, and
 *  matches the store's own SESSION_ID_RE so a stamp can never name a shape the
 *  store would refuse. */
const AUDIT_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/**
 * The config a session runs, by its STABLE id (M4).
 *
 * Recorded so the Library can resolve the config's CURRENT display name at read
 * time — rename a config and every row follows, where a stored label would
 * freeze the old name forever. NEVER used for serving or for authorizing
 * anything: it is a lookup key into the user's own configs.json and nothing
 * else, which is why the shape is pinned rather than merely bounded.
 */
export const CANVAS_CONFIG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Characters that reorder or hide the text around them, plus every control.
 *  Stripped from a display label before it is stored, so the value never exists
 *  in a renderable form anywhere — the same rule the Library row's cwd follows. */
const AUDIT_LABEL_STRIP_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/** One display label, cleaned and capped — or undefined when nothing readable
 *  survives. Absent is always legal: absent means "unknown", never "none". */
export function sanitizeAuditLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const cleaned = raw.replace(AUDIT_LABEL_STRIP_RE, '').trim()
  if (!cleaned) return undefined
  return Array.from(cleaned).slice(0, MAX_AUDIT_LABEL_CHARS).join('')
}

/**
 * WHO made a write, for the audit line.
 *
 * `at` is host-minted. `sessionLabel` and `account` are optional display text.
 * Nothing here authorizes anything — see the block comment above.
 */
export interface AuditStamp {
  sessionId: string
  sessionLabel?: string
  account?: string
  at: string
}

/**
 * A stamp read back from disk, healed to what this build understands — or
 * undefined when it is not a stamp at all.
 *
 * NEVER FATAL, and rebuilt field by field rather than spread. A stamp describes
 * provenance; a malformed one costs a row its audit line, not the canvas its
 * history. Rebuilding by name is what stops an unknown key riding through the
 * heal and back onto disk at the next persist — the same rule `sanitizeStamp`
 * follows for the evidence state stamp, and for the same reason.
 */
export function sanitizeAuditStamp(value: unknown): AuditStamp | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const s = value as Partial<AuditStamp>
  if (typeof s.sessionId !== 'string' || !AUDIT_SESSION_ID_RE.test(s.sessionId)) return undefined
  if (typeof s.at !== 'string' || s.at.length === 0 || s.at.length > MAX_AUDIT_TIME_CHARS) return undefined
  // The moment has to PARSE, not merely be a bounded string. Every reader
  // treats it as a date — the Library sorts on it, picks the newest stamp with
  // it, and renders it as an age — and an unparseable value silently wins or
  // loses those comparisons depending on which side of a string compare it
  // falls, which is exactly the class of bug the store's own sorts moved off
  // lexical order to avoid. Unparseable is not a stamp.
  if (!Number.isFinite(Date.parse(s.at))) return undefined
  const sessionLabel = sanitizeAuditLabel(s.sessionLabel)
  const account = sanitizeAuditLabel(s.account)
  return {
    sessionId: s.sessionId,
    ...(sessionLabel ? { sessionLabel } : {}),
    ...(account ? { account } : {}),
    at: s.at,
  }
}

/** A config id read back from disk: OUR shape or dropped. Never fatal. */
export function sanitizeCanvasConfigId(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_AUDIT_ID_CHARS) return undefined
  return CANVAS_CONFIG_ID_RE.test(value) ? value : undefined
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

/**
 * A version's review outcome — the C1 state machine (owner-approved on the
 * canvas, 2026-08-26). The invariant it exists to enforce: per artifact, at
 * most ONE ready version is ever OPEN (= no verdict). Rendering a new ready
 * version auto-stamps the previously open one 'superseded'; submitting a
 * review stamps 'approved' or 'rejected'; the user's chat verdicts are
 * recorded by the agent with `by: 'agent-chat'` so the audit trail says which
 * mouth spoke; 'withdrawn' is the "go back to v5, get rid of v6" move.
 * Absent on the artifact's LATEST ready version = open; absent on history
 * written before this field = healed to 'superseded' on load.
 */
export interface CanvasVersionVerdict {
  state: 'approved' | 'rejected' | 'superseded' | 'withdrawn' | 'dismissed'
  at: string
  /** 'user' = their own submit in the pane; 'agent-chat' = the agent recorded
   *  the user's words from conversation (always rendered as such, listed apart
   *  from the user's own clicks); 'system' = automatic supersession. */
  by: 'user' | 'agent-chat' | 'system'
  /** The rejection reason / chat feedback, when one was given. User or
   *  user-relayed prose — render as data, never as markup. */
  note?: string
}

/** Cap on a version's archived verdict trail (adv round 2): bounds the row
 *  and keeps a repeated reopen from ever breaching the load-time drop cap. */
export const MAX_PRIOR_VERDICTS = 32
export const VERSION_VERDICT_STATES = ['approved', 'rejected', 'superseded', 'withdrawn', 'dismissed'] as const
export const VERSION_VERDICT_ACTORS = ['user', 'agent-chat', 'system'] as const

/** Longest verdict note kept — same bound the review store puts on a note. */
export const MAX_VERDICT_NOTE_CHARS = 4000

/** Shape check for a verdict read back from disk. Same posture as `draft`:
 *  a hand-edited value that is not OUR shape must not survive into fields the
 *  queue derivation and the History badges read. */
export function isKeepableVerdict(v: unknown): v is CanvasVersionVerdict {
  if (typeof v !== 'object' || v === null) return false
  const d = v as Partial<CanvasVersionVerdict>
  if (!VERSION_VERDICT_STATES.includes(d.state as never)) return false
  if (!VERSION_VERDICT_ACTORS.includes(d.by as never)) return false
  if (typeof d.at !== 'string' || d.at.length === 0 || d.at.length > 64) return false
  if (d.note !== undefined && (typeof d.note !== 'string' || d.note.length === 0 || d.note.length > MAX_VERDICT_NOTE_CHARS)) return false
  return true
}

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
  /** ARCHIVED (item C, phase 5): the user tucked this version's artifact into
   *  the muted Archived history group — out of the way, recoverable. Set on
   *  every version of the artifact together; a hand-edited value must be the
   *  literal `true` (validated on load, like `draft`). Absent = live. */
  archived?: true
  /** A SHOW-AND-TELL (owner call, 2026-08-27): ready and surfaced like any
   *  hand-over, but it owes NO review — it never sets awaitingReview, never
   *  becomes the artifact's open version, and never supersedes one. The lane
   *  for "just showing you something": the subject can be dismissed by either
   *  side without the review ceremony, unless the user chooses to annotate it
   *  (notes put the canvas under the normal review rules). Literal `true` or
   *  absent, validated on load like `draft`. */
  show?: true
  /** The C1 review outcome. Absent = OPEN on the artifact's latest ready
   *  version; healed to superseded for older history on load. */
  verdict?: CanvasVersionVerdict
  /** Verdicts this version HELD before its current one — the audit trail a
   *  reopen must not erase (adv FINDING 2): reopening v5 clears v5's verdict
   *  and withdraws v6, and both prior verdicts (a user rejection included) are
   *  pushed here rather than lost, so a rejection can never be silently
   *  overwritten and resurrected as approved. Newest last. */
  priorVerdicts?: CanvasVersionVerdict[]
  /**
   * What the user calls this TEST PACK (M3, testing mode).
   *
   * One build under test = one run = one round = one submission, and the pack IS
   * that version plus its round — so the name lives on the version rather than
   * on the round, which is created later and may not exist yet when the user
   * renames. User-set only; absent means the pane shows the generated default
   * (`defaultPackName`), which is never stored so it cannot go stale when the
   * config or the build label changes. Cleaned like a title and capped at
   * MAX_PACK_NAME_CHARS.
   */
  packName?: string
  /**
   * WHO rendered this version (M4). Stamped at render from the spawn record;
   * absent on every version written before stamps existed, and on a session
   * main never saw spawn. Display metadata only — see `AuditStamp`.
   */
  renderedBy?: AuditStamp
}

/** The artifact's one OPEN version (C1): its latest ready version that is not
 *  withdrawn, iff it carries no verdict. Withdrawn versions are skipped so a
 *  reopen (which withdraws everything after the reopened version) still finds
 *  the earlier reopened version as the open one. Every count and badge derives
 *  from this — never stored. */
export function openVersionOf(run: readonly CanvasVersion[]): CanvasVersion | null {
  // Show-and-tell versions are outside the review flow entirely: they can
  // never be the open (review-owed) version, and they must not mask an earlier
  // review version's openness — so they are skipped, not merely returned null.
  const last = [...run].reverse().find((v) => !v.draft && !v.show && v.verdict?.state !== 'withdrawn')
  return last && !last.verdict ? last : null
}

/**
 * The version runs that the two-level history (item C) groups into artifacts —
 * shared so MAIN (archive/delete) and the RENDERER (the picker) agree on
 * exactly which versions form one artifact. A run breaks when the KIND changes
 * OR the archived state changes: two same-mode runs on either side of an
 * archive are different artifacts, and a fresh render after an archived run
 * starts a new LIVE artifact rather than joining the archived one. Drafts are
 * the agent's own loop (#366) and never appear.
 */
export function artifactRuns(versions: readonly CanvasVersion[]): CanvasVersion[][] {
  const runs: CanvasVersion[][] = []
  for (const v of versions) {
    if (v.draft) continue
    const last = runs[runs.length - 1]
    if (last && last[0].mode === v.mode && !!last[0].archived === !!v.archived) last.push(v)
    else runs.push([v])
  }
  return runs
}

/** The version run (artifact) containing `versionId`, or null. */
export function artifactRunContaining(versions: readonly CanvasVersion[], versionId: string): CanvasVersion[] | null {
  for (const run of artifactRuns(versions)) {
    if (run.some((v) => v.id === versionId)) return run
  }
  return null
}

/** The round the user owes a first review on: set when the agent deliberately
 *  marks a render ready (#366), cleared when the user submits a review on the
 *  canvas. This is one of the two inputs to the queue number (#364); the other
 *  is rounds awaiting the user's verdicts, derived from the review store. */
export interface CanvasAwaitingReview {
  versionId: string
  at: string
}

/** Canvas-level sign-off (#476): the subject reached its terminal COMPLETE
 *  state. `by: 'agent'` is only ever written on the user's explicit
 *  instruction and is rendered as such; reopening clears the stamp. */
export interface CanvasCompletion {
  at: string
  by: 'user' | 'agent'
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
  /** Present once the subject is signed off (#476). Terminal: renders are
   *  refused while it stands; Reopen clears it. */
  completed?: CanvasCompletion
  /**
   * WHO first rendered this canvas (M4), stamped once at creation and never
   * rewritten — an adoption moves the owner, it does not rewrite who made the
   * work. Absent on canvases created before stamps existed.
   */
  createdBy?: AuditStamp
  /**
   * The CONFIG the creating session ran, by its stable id (M4).
   *
   * Stamped once at creation, when the spawn record knew it. Resolved to a
   * display name AT READ against configs.json, so renaming a config renames
   * every row rather than leaving a frozen label behind. Never a serving or
   * authorization key — see CANVAS_CONFIG_ID_RE.
   */
  configId?: string
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
  /** True when this change is the subject being signed off (#476), so the
   *  renderer can show the front-page acknowledgment for THIS transition and
   *  not for ordinary refreshes. */
  completed?: boolean
  /** True when this change is a completed canvas being REOPENED (#476) — a
   *  user gesture on a canvas that may not be the session's current one, so
   *  the filing detector and the attention pulse must both stand down. */
  reopened?: boolean
}

/** Renderer → main render request (dev/test ingress; the `canvas_render` MCP
 *  tool is the agent-facing ingress — both land in the store's renderVersion).
 *
 *  `title` names the SUBJECT. A canvas holds one subject and accumulates
 *  versions of it; naming a different subject files the old canvas and starts a
 *  new one, so a fresh topic never inherits the previous topic's versions or
 *  its unresolved review notes. See renderVersion. */
export type CanvasRenderSource =
  | { mode: 'design'; html: string; title?: string; ready?: boolean; intent?: 'review' | 'show' }
  | { mode: 'plan'; html: string; title?: string; ready?: boolean; intent?: 'review' | 'show' }
  | { mode: 'uat'; distRoot: string; entry?: string; buildLabel?: string; title?: string; ready?: boolean; intent?: 'review' | 'show' }

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
 * 'ux-id' is primary for uat/design/plan alike (the authoring contract's
 * `data-ux-id`; a plan's steps carry `data-ux-id="step-N"`). 'fingerprint' is a
 * FALLBACK only — the name in it is a weak signal. One element commonly carries two refs: its
 * ux-id and, captured at the same moment, its fingerprint. Resolution walks the
 * list in order and stops at the first hit, which is what makes "ux-id lookup →
 * fingerprint fallback" one loop rather than two code paths.
 */
export type AnchorRef =
  | { kind: 'ux-id'; id: string }
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
 * `observation` is what a note filed WITH an approval becomes (the settled
 * machine, 2026-08-29). Approve means NOTHING OWED: anything that needs work is
 * a reject, so a note that rides an approval is a remark the agent should read
 * and nobody has to answer. Terminal, written ONLY by the user's own
 * approve/pass submit (`closedBy: 'user'`, `closedFrom: 'open'`), and reachable
 * from no MCP tool at all — the review store refuses to move one, by name.
 *
 * `approved` is the one state NO tool can write. Enforced in the review store
 * (`closeAnnotationsByAgent`), not merely described in a tool schema — a tool
 * description is a request, and MCP arguments are model-generated.
 */
export type AnnotationState = 'open' | 'addressed' | 'approved' | 'reannotated' | 'dismissed' | 'stale' | 'observation'

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
/** 'supersede' is the store itself settling an addressed note because the
 *  VERSION it was written against died (a newer ready render, a withdraw) —
 *  neither party clicked this particular note, and the row must not claim one
 *  did.
 *
 *  'decision' is the settled machine's own (2026-08-29): the user made a
 *  DECISION on a later version of the same artefact, and their newest
 *  submission is their authoritative statement of what is still wrong, so every
 *  earlier round beneath it closes. Always written beside `settledBy`, which
 *  names the decision — the row reads "settled by your v8 approval" rather than
 *  claiming anybody ruled on this note. */
export type AnnotationClosedBy = 'user' | 'agent' | 'supersede' | 'decision'

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

/**
 * A pasted screenshot attached to a note (Ctrl+V, item B). Unlike a sketch the
 * PNG exists at COMPOSE time — it is written when the note is saved, under
 * 'reviews/pasted/<noteId>-<k>.png', and simply stays there through submit.
 *
 * A note carries a LIST of these now (`Annotation.images`), and may carry a
 * sketch beside them: the one-attachment rule went with the rework. It came
 * from a single React state slot, so a second Ctrl+V silently overwrote the
 * first — the user pasted three screenshots and the agent was handed one.
 */
export interface AnnotationImage {
  /** Relative to the canvas's own directory ('reviews/pasted/a7-1.png'). Never
   *  empty — the file is written before the record references it. */
  pngPath: string
}

/**
 * Most pasted images one note may carry.
 *
 * Eight is past any real note and short of a paste-loop turning a review into a
 * disk-filling primitive: each image is separately capped at
 * MAX_ATTACHMENT_PNG_BYTES, so this is the multiplier on that bound.
 */
export const MAX_NOTE_IMAGES = 8

/** Longest note text, at every seam that touches one: the composer's textarea,
 *  the draft schema, the store's validator, and the persisted composer draft.
 *  One constant, because a cap the UI and the store disagree about is a note the
 *  user can write and not save. */
export const MAX_NOTE_CHARS = 4000

/**
 * Ceiling on a persisted composer sketch scene (the Excalidraw elements JSON).
 *
 * Main never parses it — the scene is opaque there, exactly like the note text
 * is opaque to the bridge — so the only defence against a runaway glass is a
 * byte bound. Half a megabyte is a few thousand strokes; a scene past that is a
 * bug, not a drawing.
 */
export const MAX_SKETCH_SCENE_BYTES = 512 * 1024

/**
 * Most elements a persisted composer scene may stamp.
 *
 * The companion to the byte cap, and keyed by what it actually bounds: one
 * stamp per glass element. The bound it replaces was `MAX_SKETCH_ELEMENT_IDS * 4`
 * — a per-NOTE limit multiplied by a guess — which sat far below what half a
 * megabyte of scene can legitimately hold, so a large drawing was refused by the
 * stamps long before its bytes were anywhere near the ceiling.
 */
export const MAX_SKETCH_SCENE_ELEMENTS = 2000

/** Byte cap shared by every note-attachment PNG — sketch exports and pasted
 *  images alike. The IPC base64 bound and the store's decoder both derive from
 *  it. */
export const MAX_ATTACHMENT_PNG_BYTES = 2 * 1024 * 1024

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
  /** Element/region only. */
  focus?: FocusObject
  sketch?: AnnotationSketch
  /**
   * Pasted screenshots (Ctrl+V), in PASTE ORDER and at most MAX_NOTE_IMAGES.
   *
   * Ordered because the order is referenced: the note's text may say "Image 2",
   * and the serializer numbers the attachments from this list so the words and
   * the image blocks cannot drift. A note may carry these AND a sketch — the old
   * mutual exclusion is gone, since a drawing now rides its note automatically
   * rather than competing with a paste for one slot. When the list is non-empty
   * the note's TEXT may be empty: the images are the note.
   *
   * Records written before the rework carry a single `image` instead; the load
   * heal lifts it to `images: [image]`.
   */
  images?: AnnotationImage[]
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
   * The variant the USER picked (#373). Two ways in, both the user's decision:
   * their own Approve click in the pane (rides the verdict IPC), or a pick they
   * stated in chat that the agent records via `canvas_pick` — the latter always
   * stamped `pickSource: 'chat'` so the two never read the same. It only ever
   * names a key that exists in `variants`. Cleared on reopen.
   */
  chosenVariantKey?: string
  /**
   * How the pick was made, when it was NOT the user's own click. 'chat' means
   * the user named the winner in conversation and the agent recorded it with
   * `canvas_pick`. Present only beside an agent-recorded approval
   * (`state: 'approved'`, `closedBy: 'agent'`, `chosenVariantKey` set) — the
   * validator refuses it anywhere else, which keeps click-approve provenance
   * the user's alone.
   */
  pickSource?: 'chat'
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
   * `approved` beside 'agent' exists in exactly one form: a chat pick the agent
   * recorded via `canvas_pick`, which always carries `pickSource: 'chat'` — the
   * validator refuses the pair without it, so a click-approval can never be
   * imitated.
   */
  closedBy?: AnnotationClosedBy
  /**
   * WHICH user decision settled this note (the settled machine, 2026-08-29).
   *
   * Present iff `closedBy === 'decision'`, and it is what makes that provenance
   * legible: the panel says "settled by your v8 approval" / "superseded by your
   * Review #8" rather than the anonymous "the store closed it". `reviewId` is
   * present only when the decision carried a round of its own — a zero-note
   * approve settles just as hard and has no review to name.
   */
  settledBy?: { versionId: string; reviewId?: string }
  /**
   * The version the AGENT says its fix landed in (`canvas_resolve`'s
   * `updatedIn`), rendered as the chip "updated in v9".
   *
   * A claim, not a verdict — the same standing as `addressed` itself. It is
   * validated as a version id that exists on the canvas so the chip can never
   * point at nothing, and it is the one piece of "what happened since you
   * wrote this" the panel can show without the user re-reading the diff.
   */
  addressedIn?: string
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
   * When the USER last reopened this note (#470). Its presence is what the
   * supersede sweep reads: a reopened note is the user deliberately putting a
   * settled thing back in play, so no automatic settle may ever touch its
   * round again — only their own verdict ends it. Set on every reopen; never
   * cleared (a terminal note's stamp is inert history).
   */
  reopenedAt?: string
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
  /**
   * THE LOCKED EVIDENCE (M3, Testing mode only): the screenshot of the framed
   * page as it stood when the user started this note, plus the state stamp and
   * the action trail taken with it.
   *
   * Present only on notes written against a `uat` version, and absent on every
   * note written before Testing captured anything — a legacy note is not
   * malformed, it simply has no pack. A note carrying evidence may have EMPTY
   * TEXT: the picture and the stamp are the note.
   *
   * The shot path is minted in main from this note's own id and re-validated on
   * load; it is never taken from a caller, which is what keeps the read channel
   * from becoming a file-read primitive.
   */
  evidence?: AnnotationEvidence
  /**
   * WHO wrote this note (M4), stamped once at create and never rewritten — a
   * later edit is the same person's note, and a rebind moves the canvas rather
   * than the authorship.
   *
   * Display metadata only (see `AuditStamp`): the close-out barrier reads
   * `addressedBy` / `userSawAddressed`, never this. Absent on every note
   * written before stamps existed.
   */
  author?: AuditStamp
}

/**
 * Why a round is no longer live. Present iff `status === 'resolved'`; cleared by
 * the user's Reopen.
 *
 *  - 'observation' — every note on it was filed WITH an approval, so nothing was
 *    ever owed;
 *  - 'decision'    — the user's later decision on `versionId` settled it (W4),
 *    with `reviewId` when that decision carried a round of its own;
 *  - 'agent'       — `canvas_verdict` / `canvas_pick` closed its last live note
 *    on the user's word, behind the seen barrier that still guards both;
 *  - 'supersede'   — the VERSION its notes hang off died (a newer ready render,
 *    a withdraw) and the store settled what was left;
 *  - 'force'       — the user's Mark complete force-closed it;
 *  - 'legacy'      — healed on load from a pre-rework record.
 */
export interface ReviewSettled {
  at: string
  by: 'observation' | 'decision' | 'agent' | 'supersede' | 'force' | 'legacy'
  versionId?: string
  reviewId?: string
}

export interface Review {
  /** 'R7' — rendered as 'Review #7'. Minted by the store. */
  id: string
  canvas: CanvasHandle
  /** The active version at submit time (D12: resolution runs against the
   *  agent's FINAL render of its turn, one pass per turn). */
  versionId: string
  annotationIds: string[]
  /**
   * 'submitted' is LIVE (the artefact's one active round) and 'resolved' is
   * SETTLED. The pair is one-way from here on: nothing but the user's own
   * Reopen — of the round, or of a single note on it — may move `resolved` back
   * to `submitted`. Every automatic path that used to walk backwards is what
   * produced the zombie rounds the settled machine exists to kill.
   */
  status: 'draft' | 'submitted' | 'resolved'
  createdAt: string
  submittedAt?: string
  /** The decision this round carried, stamped at submit. Absent on rounds
   *  submitted before decisions existed. */
  decision?: 'approve' | 'reject'
  settled?: ReviewSettled
  /**
   * THE WHOLE RUN's action trail (M3), stamped at submit — everything the user
   * did between opening the build and sending the pack, capped at
   * MAX_TRAIL_ENTRIES_PER_RUN.
   *
   * On the ROUND rather than on a note, because it describes the run and not any
   * one observation: the per-note slices under `Annotation.evidence.trail` say
   * what led to each note, and this says what the session as a whole looked
   * like. Absent on every round submitted outside Testing.
   */
  trail?: TrailEntry[]
}

/** What `canvas_review` returns to the agent (the pull side of D10). */
export interface ReviewPayload {
  review: Review
  /** Element/region notes; `snapshotContext` is a scoped subtree when one was
   *  captured with the note (optional — absent in v1). */
  annotations: Array<Annotation & { snapshotContext?: SnapshotNode }>
  generalNotes: Annotation[]
  /**
   * Attachment PNGs, served to the agent as image blocks alongside the text, in
   * the order the notes refer to them: each note's pasted images (1..N), then
   * its drawing.
   *
   * `kind` and `imageIndex` are what let the text say "Image 2 = attachment 5":
   * a note carries several images now and its prose names them by position, so
   * an untyped flat list could not tell the agent which block is which.
   */
  attachments: Array<{ annotationId: string; pngPath: string; kind: 'sketch' | 'image'; imageIndex?: number }>
  /**
   * Earlier rounds THIS submission settled (W4), and per round the notes that
   * were still `open` when it did — never answered by anybody.
   *
   * Reported because the settle is silent otherwise: the user's newest
   * submission is their authoritative statement of what is still wrong, so an
   * unanswered note from three rounds ago legitimately stops being owed — but
   * the agent should still SEE that it existed rather than have it vanish
   * between two tool calls.
   */
  settledByThisSubmission?: Array<{ reviewId: string; neverResolved: Annotation[] }>
  envelope: 'untrusted-content'
}

// ── The derived reading of a canvas (the settled machine, 2026-08-29) ───────
//
// NEEDS-YOU / WITH-THE-AGENT / SETTLED are DERIVED, after the settle rules have
// run — never stored. A stored phase is a phase that can be WRONG, and every
// strand in the live repros was a stored answer that the record had already
// contradicted. These live in shared/ because main and the renderer both read
// them, and two implementations of "who is this waiting on" is exactly how the
// pill and the panel came to disagree.

/** The two states a note is still waiting on somebody in: 'open' waits on the
 *  agent, 'addressed' waits on nobody but is still part of the live round. */
export type LiveNoteState = 'open' | 'addressed'

export function isLiveNote(a: Annotation): boolean {
  return a.state === 'open' || a.state === 'addressed'
}

/**
 * A note nobody is waiting on any more. NOT the same as "gone" — the text
 * stays, the row says how it settled, and Reopen is one click.
 *
 * 'reannotated' is neither live nor settled: it has a LIVE SUCCESSOR carrying
 * the same issue, so counting it either way double-counts one piece of feedback.
 */
export function isSettledNote(a: Annotation): boolean {
  return a.state === 'observation' || a.state === 'stale' || a.state === 'dismissed' || a.state === 'approved'
}

/**
 * The artefact's phase — what the pane's status line and the Library's owed-text
 * read.
 *
 * Priority is the ball's: an OPEN version is the user's to decide, whatever else
 * is on the record, because that is the gesture that also settles everything
 * beneath it. Only with no open version does a live round mean the agent has the
 * ball.
 */
export type ArtifactPhase =
  | { kind: 'needs-you'; versionId: string }
  | { kind: 'with-agent'; reviewId: string; openNotes: number; addressedNotes: number; awaiting: 'next-version' }
  | { kind: 'settled'; versionId: string; verdict: 'approved' | 'rejected' | 'dismissed' | 'withdrawn' | 'superseded' }
  | { kind: 'empty' }

/**
 * Which rounds belong to ONE artefact run.
 *
 * A round belongs only when its frozen version AND every one of its notes lie
 * inside the run. A round that SPANS artefacts (the agent rendered a plan
 * between the user's note and their submit, so the round froze on the plan while
 * its notes point at the mockup) belongs to neither — the fail-closed side, and
 * the same rule the store's settle uses, so the phase the user reads and the
 * settle the store performs can never disagree about scope.
 */
function reviewsOfRun(
  runVersionIds: ReadonlySet<string>,
  reviews: readonly Review[],
  annotations: readonly Annotation[],
): Review[] {
  const notesByReview = new Map<string, Annotation[]>()
  for (const a of annotations) {
    const list = notesByReview.get(a.reviewId)
    if (list) list.push(a)
    else notesByReview.set(a.reviewId, [a])
  }
  return reviews.filter((r) => {
    if (!runVersionIds.has(r.versionId)) return false
    return (notesByReview.get(r.id) ?? []).every((a) => runVersionIds.has(a.versionId))
  })
}

export function artifactPhaseOf(
  run: readonly CanvasVersion[],
  reviews: readonly Review[],
  annotations: readonly Annotation[],
): ArtifactPhase {
  const ready = run.filter((v) => !v.draft)
  if (ready.length === 0) return { kind: 'empty' }

  const open = openVersionOf(run)
  if (open) return { kind: 'needs-you', versionId: open.id }

  const runIds = new Set(run.map((v) => v.id))
  const mine = reviewsOfRun(runIds, reviews, annotations)
  const memberIds = new Set(mine.map((r) => r.id))
  // The newest LIVE round. There is meant to be at most one — "ONE active
  // round" is the invariant — but a user Reopen can legitimately make a second,
  // and reporting the newest is the honest reading of "what is in flight".
  const live = mine
    .filter((r) => r.status === 'submitted')
    .sort((a, b) => Number(b.id.slice(1)) - Number(a.id.slice(1)))[0]
  if (live) {
    const notes = annotations.filter((a) => a.reviewId === live.id && memberIds.has(a.reviewId))
    return {
      kind: 'with-agent',
      reviewId: live.id,
      openNotes: notes.filter((a) => a.state === 'open').length,
      addressedNotes: notes.filter((a) => a.state === 'addressed').length,
      awaiting: 'next-version',
    }
  }

  // Nothing open, nothing live: the artefact's outcome is its newest decided
  // version. A run whose ready versions carry no verdict at all was never
  // offered for review (a show-and-tell lane), so it reports `empty` rather
  // than inventing a verdict nobody gave.
  const decided = [...ready].reverse().find((v) => v.verdict)
  if (!decided?.verdict) return { kind: 'empty' }
  return { kind: 'settled', versionId: decided.id, verdict: decided.verdict.state }
}

/**
 * Exactly what a FORCE complete would close on one canvas (W3).
 *
 * ONE declaration, because four surfaces read it and the confirm's label is
 * built from it: main composes it (`describeForceClosures`), the preload bridge
 * and the renderer d.ts carry it, and the button turns it into the sentence the
 * user is asked to agree to. Two copies of this shape is how a confirm comes to
 * promise something the mutation does not do.
 */
export interface ForceClosures {
  /** Draft notes the user never sent. A force DELETES these: an unsent note is
   *  their own scratch, and closing it "as not done" would file a claim they
   *  never made. */
  unsentNotes: number
  /** Live notes still with the agent. */
  openNotes: number
  /** Live notes the agent has claimed. */
  addressedNotes: number
  /** EVERY artefact run's open version, not just the awaited one — an open
   *  version anywhere on the canvas is a decision the user still owes, and a
   *  force stamps each of them `dismissed`. */
  unreviewedVersionIds: string[]
}

/** Ids the review store mints. Tighter than path-safe on purpose (these appear
 *  in file names under the canvas dir): the store never mints anything else. */
export const CANVAS_REVIEW_ID_RE = /^R[0-9]{1,9}$/
export const CANVAS_ANNOTATION_ID_RE = /^a[0-9]{1,9}$/

/**
 * The half-written note, PERSISTED (W14).
 *
 * Everything the composer holds — the decision, the text, the target, the pasted
 * images, the drawing on the glass — lived only in React state before the
 * rework, so switching to the terminal and back threw it away without asking.
 * A draft belongs to the version it was written on (`versionId`) and to the
 * canvas it is filed under; there is exactly one per canvas, because there is
 * exactly one composer.
 *
 * `sketch.scene` is OPAQUE to main: it is the Excalidraw elements JSON the pane
 * serialised, bounded by MAX_SKETCH_SCENE_BYTES and never parsed there. `versions`
 * stamps each element with the version it was drawn on, so a restore can put the
 * foreign-version stash back where the pane had it.
 */
/**
 * The glass, serialised — ONE declaration, because four places carry it.
 *
 * The pane produces it (`getSketchSceneForPersist`) and consumes it
 * (`restoreSketchScene`), the panel moves it to and from main, and main stores
 * it verbatim. `scene` is the Excalidraw elements JSON and is OPAQUE everywhere
 * outside the glass: bounded in bytes, never parsed. `versions` stamps each
 * element with the version it was drawn on, so a restore can put the
 * foreign-version stash back where the pane had it.
 *
 * Declared here rather than beside any one of its users because a structural
 * copy in each is how the four drift into disagreeing about a field.
 */
export interface CanvasSketchScene {
  scene: string
  versions: Record<string, string>
}

export interface ComposerDraft {
  versionId: string
  decision?: 'approve' | 'reject'
  /** ≤ MAX_NOTE_CHARS. */
  text: string
  focus?: FocusObject
  /** 'reviews/composer/img-<k>.png', in paste order. */
  images: AnnotationImage[]
  sketch?: CanvasSketchScene
  /** The pending Testing capture this half-written note is holding (M3), so a
   *  pane switch does not throw away the screenshot the shield was taken over.
   *  Cleared when the note is saved (the capture moves onto it), when the user
   *  cancels, and at submit. */
  evidenceId?: string
  updatedAt: string
}

/**
 * Renderer → main for the composer draft.
 *
 * The images name a SOURCE, never a destination: `{ keepIndex: k }` is "the
 * image persisted at index k of the draft you already hold", so a debounced save
 * costs no bytes for images the renderer stopped holding. `'keep'` is the
 * shorthand for "the one at this same index" and means exactly
 * `{ keepIndex: <its own position> }`.
 *
 * Naming the source is what makes REMOVAL and REORDER safe. Under a
 * destination-indexed scheme, deleting image 1 of three and sending
 * `['keep','keep']` resolves both entries against the old list's first two —
 * silently keeping the image the user just deleted and dropping the last one.
 */
export interface ComposerDraftInput {
  versionId: string
  decision?: 'approve' | 'reject'
  text: string
  focus?: FocusObject
  images: Array<'keep' | { keepIndex: number } | { pngBase64: string }>
  sketch?: CanvasSketchScene
  /** The pending Testing capture the composer is holding (M3). An id only. */
  evidenceId?: string
}

/** What the renderer holds per session for reviews (IPC `canvas:reviewGetState`). */
export interface CanvasReviewState {
  canvasId: string
  sessionId: string
  reviews: Review[]
  annotations: Annotation[]
  /** The unsent composer for THIS canvas, restored on mount (W14). Absent when
   *  nothing is half-written. */
  composer?: ComposerDraft
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
  /**
   * The pasted screenshots this save carries, in order (item B, W15).
   *
   * Three forms, and the last two exist because the renderer stops holding the
   * BYTES the moment an image is persisted — it holds a position:
   *   - `{ pngBase64 }`      a fresh paste, bytes riding the call;
   *   - `{ fromComposer: k }` image k of the PERSISTED COMPOSER draft — main
   *                           moves that file onto the note;
   *   - `{ fromNote: k }`     image k this note ALREADY carries, kept where the
   *                           list now puts it (the position may have moved:
   *                           removing image 1 renumbers the rest).
   *
   * Absent removes every image; an empty array does the same. A note may carry
   * these AND a sketch.
   */
  images?: Array<{ pngBase64: string } | { fromComposer: number } | { fromNote: number }>
  versionId: string
  /**
   * The PENDING capture this note locks (M3, Testing mode).
   *
   * An id, never a path and never a picture: main holds the shot it took —
   * together with the stamp and trail slice it took at the same instant — under
   * this id, and saving MOVES that file onto the note. So the record the note
   * ends up carrying is the one the capture produced, and a caller cannot dress
   * a note in a stamp that describes some other screen.
   */
  evidenceId?: string
}

/** Renderer → main at submit: one exported PNG per sketch-carrying note. */
export interface CanvasSketchExport {
  annotationId: string
  /** Base64 PNG (no data: prefix). Capped by schema and re-checked in main. */
  pngBase64: string
}

// ── Testing mode: evidence, state stamp, action trail (M3) ──────────────────
//
// A note written in Testing is a LOCKED EVIDENCE RECORD. The moment the user
// starts one the site is paused, the framed page is screenshotted, and two
// structured records are taken beside the picture: the STATE STAMP (what the
// screen WAS) and the ACTION TRAIL (what the user DID to get there). Saving the
// note locks all three to it; cancelling throws the capture away.
//
// THE RULE THAT SHAPES EVERY TYPE BELOW: structure, never content. The stamp
// says a field is filled and how the form judged it; it never says what was
// typed. The trail says the user typed into a field; it never says what. That is
// the same line `SnapshotNode.state.valueLength` draws and the same line the
// bridge's key relay draws — relaying the values would be a keylogger wearing a
// feature's name — and it is drawn here too because this record is the one that
// gets WRITTEN TO DISK and handed to a model.

/** Longest evidence screenshot kept, after the downscale ladder. A review shot
 *  is a picture of a page, not a print master; past this the pack stops being
 *  something a user can keep dozens of. */
export const MAX_EVIDENCE_SHOT_BYTES = 300 * 1024

/** Ceiling on ONE canvas's whole evidence pack. Capture is refused past it with
 *  a plain reason rather than silently degrading — a run that has filled 30 MB
 *  of screenshots is one the user should prune or finish. */
export const MAX_EVIDENCE_PACK_BYTES = 30 * 1024 * 1024

/** Trail entries kept for a whole run (the ring the renderer holds, and the cap
 *  the submit seam re-applies). */
export const MAX_TRAIL_ENTRIES_PER_RUN = 500

/** Trail entries kept on ONE note — the slice since the previous note. */
export const MAX_TRAIL_ENTRIES_PER_NOTE = 200

/** Form fields one stamp may describe. A page with more than forty inputs on
 *  screen is not a form the stamp can usefully summarise anyway. */
export const MAX_STAMP_FIELDS = 40

/** Open dialogs/modals one stamp may name. */
export const MAX_STAMP_DIALOGS = 8

/** Longest user-set pack name. A pack name labels a run; it is not a report. */
export const MAX_PACK_NAME_CHARS = 80

/** Longest page-reported role/name/ux-id in a stamp target — the same bound a
 *  focus label already carries, for the same reason: it is the page's word. */
export const MAX_STAMP_TARGET_CHARS = 120
/** Longest page-reported document title in a stamp. */
export const MAX_STAMP_TITLE_CHARS = 200
/** Longest page-reported route (pathname + hash) anywhere in this contract. */
export const MAX_STAMP_ROUTE_CHARS = 512

/**
 * How a form field stood when the note was written.
 *
 * Four states and not one of them is a value. `changed` is measured against the
 * run's BASELINE snapshot (the first load of this version), which is what turns
 * "this field has text in it" into the far more useful "the user changed this
 * field during the test" — without ever recording either text.
 */
export type FieldFill = 'empty' | 'filled' | 'changed' | 'invalid'

/**
 * WHO an element is, as the page reports itself.
 *
 * Identity only — role, accessible name, and the authoring contract's
 * `data-ux-id` when it has one. Page-authored text, so every surface that shows
 * one marks it as such (PAGE_REPORTED_MARK), and every string is capped at
 * MAX_STAMP_TARGET_CHARS at the trust boundary.
 */
export interface StampTarget {
  role: string
  name: string
  uxId?: string
}

/** The screen, as STRUCTURE, at the moment a note was started. */
export interface EvidenceStateStamp {
  /** ISO. Host-minted, never the page's. */
  capturedAt: string
  /** Page-reported document title. */
  title?: string
  /** Page-reported pathname + hash. Never the query string: a query is where
   *  applications put tokens, ids and search terms, i.e. content. */
  route?: string
  viewport: {
    width: number
    height: number
    scrollX: number
    scrollY: number
    dpr: number
    /** The PANE's zoom, host-owned — not a page-reported number. */
    zoom: number
  }
  /** Open dialogs / modals, at most MAX_STAMP_DIALOGS. */
  dialogs: StampTarget[]
  /** The control holding keyboard focus, when the page reported one. */
  focused?: StampTarget
  /** Form controls and how they stood — NEVER what they held. At most
   *  MAX_STAMP_FIELDS. */
  fields: Array<StampTarget & { fill: FieldFill }>
}

/**
 * One thing the user DID, and when.
 *
 * `at` is the ISO moment and `gapMs` the pause since the previous entry, so the
 * agent reads a rhythm ("+3.1s") rather than a wall of timestamps. Every variant
 * carries identity or a route and none of them carries a value: `typed` names
 * the field, once per focus session, and says nothing about the keystrokes.
 *
 * There is deliberately NO `history` kind. A popstate is a route change and is
 * recorded as `navigate`: the platform does not say whether Back or Forward
 * produced it, so a separate kind could only ever render as the bare word
 * "history", which tells a reader strictly less than the route does. A kind no
 * producer can populate is a kind every validator and serializer still has to
 * carry a branch for.
 */
export type TrailEntry =
  | { at: string; gapMs: number; kind: 'click'; target: StampTarget | null }
  | { at: string; gapMs: number; kind: 'typed'; target: StampTarget }
  | { at: string; gapMs: number; kind: 'navigate'; route: string }
  | { at: string; gapMs: number; kind: 'scroll'; scrollY: number }
  | { at: string; gapMs: number; kind: 'note'; annotationId?: string }

/** The trail kinds this build understands. A frozen list rather than a bare
 *  union, because the check enforcing it runs at RUNTIME on a record read back
 *  from disk. */
export const TRAIL_KINDS = ['click', 'typed', 'navigate', 'scroll', 'note'] as const

/** The fill states a stamp field may carry. Same reason as TRAIL_KINDS. */
export const FIELD_FILLS = ['empty', 'filled', 'changed', 'invalid'] as const

/** What a locked note carries beside the user's words. */
export interface AnnotationEvidence {
  /** 'reviews/evidence/<annotationId>.png' (or .jpg), relative to the canvas
   *  directory — the SAME rule the sketch and pasted-image paths follow, so a
   *  moved resources dir never orphans a pack. Minted in main from the note id;
   *  the extension records which encoder the ladder ended on. */
  shotPath: string
  width: number
  height: number
  stamp: EvidenceStateStamp
  /** The slice since the previous note, at most MAX_TRAIL_ENTRIES_PER_NOTE. */
  trail: TrailEntry[]
}

/** The one shape a stored evidence shot path may have. Minted in main and
 *  re-validated on load, exactly like PNG_PATH_RE — so a hand-edited record can
 *  never point the read channel at a file of its choosing. */
export const EVIDENCE_SHOT_PATH_RE = /^reviews\/evidence\/a[0-9]{1,9}\.(png|jpg)$/

/** A pending (captured, not yet locked) shot. Minted from `randomId()`. */
export const EVIDENCE_ID_RE = /^[0-9a-f]{24}$/

/** Why a capture was refused. A closed vocabulary: the renderer turns each into
 *  plain words, and nothing free-text ever reaches that message. */
export type EvidenceCaptureRefusal = 'rate' | 'pack-full' | 'capture-failed' | 'not-owner' | 'not-uat'

export type EvidenceCaptureResult =
  | { ok: true; evidenceId: string; previewDataUrl: string; width: number; height: number }
  | { ok: false; reason: EvidenceCaptureRefusal }

/** ISO timestamps everywhere in this contract are host-minted; the bound is the
 *  same one every other stored stamp carries. */
const STAMP_TIME_MAX = 64

// eslint-disable-next-line no-control-regex
const EVIDENCE_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/

/** A page-reported string that is safe to store and show: bounded, and with no
 *  control character that could make one line read as two. */
function isCleanReportedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !EVIDENCE_CONTROL_CHARS.test(value)
}

/**
 * Every key a record of this kind may carry, and nothing else.
 *
 * A CLOSED key set rather than a per-field check, because a per-field check
 * answers "is what I looked at well formed" and the question here is "is there
 * anything in this object I did not look at". A hand-edited reviews.json (or a
 * future producer nobody re-read this file for) could otherwise hang arbitrary
 * fields off a stamp — including a `value` — and the heal, which only rebuilds
 * the fields it knows, would carry them straight through to disk and into the
 * agent's JSON view of the round.
 */
function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  for (const key in value) {
    if (!allowed.includes(key)) return false
  }
  return true
}

const STAMP_TARGET_KEYS = ['role', 'name', 'uxId'] as const
const STAMP_FIELD_KEYS = ['role', 'name', 'uxId', 'fill'] as const
const STAMP_KEYS = ['capturedAt', 'title', 'route', 'viewport', 'dialogs', 'focused', 'fields'] as const
const STAMP_VIEWPORT_KEYS = ['width', 'height', 'scrollX', 'scrollY', 'dpr', 'zoom'] as const
const EVIDENCE_KEYS = ['shotPath', 'width', 'height', 'stamp', 'trail'] as const
const TRAIL_KEYS: Readonly<Record<string, readonly string[]>> = {
  click: ['at', 'gapMs', 'kind', 'target'],
  typed: ['at', 'gapMs', 'kind', 'target'],
  navigate: ['at', 'gapMs', 'kind', 'route'],
  scroll: ['at', 'gapMs', 'kind', 'scrollY'],
  note: ['at', 'gapMs', 'kind', 'annotationId'],
}

function isStampTarget(value: unknown, allowed: readonly string[] = STAMP_TARGET_KEYS): value is StampTarget {
  if (typeof value !== 'object' || value === null) return false
  if (!hasOnlyKeys(value, allowed)) return false
  const t = value as Partial<StampTarget>
  if (!isCleanReportedString(t.role, MAX_STAMP_TARGET_CHARS)) return false
  if (!isCleanReportedString(t.name, MAX_STAMP_TARGET_CHARS)) return false
  if (t.uxId !== undefined && !isCleanReportedString(t.uxId, MAX_STAMP_TARGET_CHARS)) return false
  return true
}

function isFiniteNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Is this a trail entry THIS build understands?
 *
 * Strict, and the strictness is the point: an unknown `kind` is not a
 * near-miss to be repaired, it is a shape nobody in this process wrote. Callers
 * that read a record off disk drop what fails rather than failing the record —
 * a trail is provenance, and losing a canvas's whole review history to one bad
 * line would be the worse bug (see `sanitizeTrail`).
 */
export function isKeepableTrailEntry(value: unknown): value is TrailEntry {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Partial<TrailEntry> & Record<string, unknown>
  if (!isCleanReportedString(e.at, STAMP_TIME_MAX) || (e.at as string).length === 0) return false
  if (!isFiniteNum(e.gapMs) || e.gapMs < 0) return false
  if (typeof e.kind !== 'string' || !(TRAIL_KINDS as readonly string[]).includes(e.kind)) return false
  // Nothing the shape does not declare. `sanitizeTrail` keeps entries VERBATIM
  // rather than rebuilding them, so this is the only thing standing between a
  // hand-edited line and the record — and the agent's `format: 'json'` view
  // prints whatever the record holds.
  if (!hasOnlyKeys(e, TRAIL_KEYS[e.kind] ?? [])) return false
  switch (e.kind) {
    case 'click':
      return e.target === null || isStampTarget(e.target)
    case 'typed':
      return isStampTarget(e.target)
    case 'navigate':
      return isCleanReportedString(e.route, MAX_STAMP_ROUTE_CHARS)
    case 'scroll':
      return isFiniteNum(e.scrollY)
    case 'note':
      return e.annotationId === undefined || (typeof e.annotationId === 'string' && CANVAS_ANNOTATION_ID_RE.test(e.annotationId))
    default:
      return false
  }
}

/**
 * Keep at most `max` trail entries this build understands, NEWEST last.
 *
 * Truncates from the FRONT: a trail is read for what led up to the note (or the
 * submit), so when something has to go it is the oldest scrolling, not the click
 * that immediately preceded the note. Never throws and never returns undefined —
 * a malformed line costs that line.
 */
export function sanitizeTrail(value: unknown, max: number): TrailEntry[] {
  if (!Array.isArray(value)) return []
  const kept: TrailEntry[] = []
  // Bounded before filtering as well as after: a hand-edited array of a million
  // entries must cost a walk of `max`-worth of tail, not of the whole array.
  const window = value.length > max * 4 ? value.slice(value.length - max * 4) : value
  for (const entry of window) {
    if (isKeepableTrailEntry(entry)) kept.push(entry)
  }
  return kept.length > max ? kept.slice(kept.length - max) : kept
}

/** Is this a state stamp THIS build understands? Strict, and CLOSED — no key it
 *  does not declare. See `hasOnlyKeys` for why the closed set matters here. */
export function isKeepableStamp(value: unknown): value is EvidenceStateStamp {
  if (typeof value !== 'object' || value === null) return false
  if (!hasOnlyKeys(value, STAMP_KEYS)) return false
  const s = value as Partial<EvidenceStateStamp> & Record<string, unknown>
  if (!isCleanReportedString(s.capturedAt, STAMP_TIME_MAX) || (s.capturedAt as string).length === 0) return false
  if (s.title !== undefined && !isCleanReportedString(s.title, MAX_STAMP_TITLE_CHARS)) return false
  if (s.route !== undefined && !isCleanReportedString(s.route, MAX_STAMP_ROUTE_CHARS)) return false
  const v = s.viewport as Partial<EvidenceStateStamp['viewport']> | undefined
  if (typeof v !== 'object' || v === null) return false
  if (!hasOnlyKeys(v, STAMP_VIEWPORT_KEYS)) return false
  for (const n of [v.width, v.height, v.scrollX, v.scrollY, v.dpr, v.zoom]) {
    if (!isFiniteNum(n)) return false
  }
  if (!Array.isArray(s.dialogs) || s.dialogs.length > MAX_STAMP_DIALOGS) return false
  if (!s.dialogs.every((d) => isStampTarget(d))) return false
  if (s.focused !== undefined && !isStampTarget(s.focused)) return false
  if (!Array.isArray(s.fields) || s.fields.length > MAX_STAMP_FIELDS) return false
  for (const raw of s.fields) {
    if (!isStampTarget(raw, STAMP_FIELD_KEYS)) return false
    const fill = (raw as { fill?: unknown }).fill
    if (typeof fill !== 'string' || !(FIELD_FILLS as readonly string[]).includes(fill)) return false
  }
  return true
}

/** One stamp target, rebuilt field by field, so nothing rides along. */
function pickStampTarget(value: unknown): StampTarget | undefined {
  if (!isStampTarget(value)) return undefined
  const t = value as StampTarget
  return { role: t.role, name: t.name, ...(t.uxId !== undefined ? { uxId: t.uxId } : {}) }
}

/**
 * The stamp, truncated to its caps and stripped of entries this build does not
 * understand — or undefined when what is left is not a stamp at all.
 *
 * NEVER FATAL. A stamp is a description of a screen; a malformed one costs the
 * note its chips, not the canvas its history.
 *
 * REBUILT BY NAME, never spread. `{ ...s }` copies whatever the file happened to
 * hold — so a hand-edited reviews.json carrying `fields: [{ …, value: "…" }]`
 * would have its extra keys preserved by the heal, written back on the next
 * persist, and printed verbatim by `canvas_review format:'json'`. The closed key
 * set in `isKeepableStamp` refuses such a record; this rebuild is what makes the
 * refusal survivable, by producing a clean stamp from the parts that are valid
 * instead of failing the note.
 */
export function sanitizeStamp(value: unknown): EvidenceStateStamp | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const s = value as Partial<EvidenceStateStamp> & Record<string, unknown>
  const v = (typeof s.viewport === 'object' && s.viewport !== null ? s.viewport : {}) as Partial<
    EvidenceStateStamp['viewport']
  >
  const dialogs: StampTarget[] = []
  if (Array.isArray(s.dialogs)) {
    for (const raw of s.dialogs) {
      if (dialogs.length >= MAX_STAMP_DIALOGS) break
      const target = pickStampTarget(raw)
      if (target) dialogs.push(target)
    }
  }
  const fields: Array<StampTarget & { fill: FieldFill }> = []
  if (Array.isArray(s.fields)) {
    for (const raw of s.fields) {
      if (fields.length >= MAX_STAMP_FIELDS) break
      const fill = (raw as { fill?: unknown } | null)?.fill
      if (typeof fill !== 'string' || !(FIELD_FILLS as readonly string[]).includes(fill)) continue
      // Validated against the FIELD key set (which admits `fill`), then rebuilt
      // from the three identity parts — so a fourth key cannot ride through.
      const identity = pickStampTargetFromField(raw)
      if (!identity) continue
      fields.push({ ...identity, fill: fill as FieldFill })
    }
  }
  const focused = pickStampTarget(s.focused)
  const candidate: EvidenceStateStamp = {
    capturedAt: typeof s.capturedAt === 'string' ? s.capturedAt : '',
    ...(typeof s.title === 'string' ? { title: s.title } : {}),
    ...(typeof s.route === 'string' ? { route: s.route } : {}),
    viewport: {
      width: isFiniteNum(v.width) ? v.width : 0,
      height: isFiniteNum(v.height) ? v.height : 0,
      scrollX: isFiniteNum(v.scrollX) ? v.scrollX : 0,
      scrollY: isFiniteNum(v.scrollY) ? v.scrollY : 0,
      dpr: isFiniteNum(v.dpr) ? v.dpr : 1,
      zoom: isFiniteNum(v.zoom) ? v.zoom : 1,
    },
    dialogs,
    ...(focused ? { focused } : {}),
    fields,
  }
  return isKeepableStamp(candidate) ? candidate : undefined
}

/** A field's identity, checked against the FIELD key set (which admits `fill`)
 *  and then rebuilt without it. */
function pickStampTargetFromField(value: unknown): StampTarget | undefined {
  if (!isStampTarget(value, STAMP_FIELD_KEYS)) return undefined
  const t = value as StampTarget
  return { role: t.role, name: t.name, ...(t.uxId !== undefined ? { uxId: t.uxId } : {}) }
}

/** Is this an evidence record THIS build understands? The record validator's
 *  question; `sanitizeEvidence` is the load heal's. */
export function isKeepableEvidence(value: unknown): value is AnnotationEvidence {
  if (typeof value !== 'object' || value === null) return false
  // Closed, for the reason the stamp's key set is: `sanitizeEvidence` rebuilds
  // only the five fields it knows, so an unknown sixth would otherwise be
  // preserved by the heal and persisted.
  if (!hasOnlyKeys(value, EVIDENCE_KEYS)) return false
  const e = value as Partial<AnnotationEvidence> & Record<string, unknown>
  if (typeof e.shotPath !== 'string' || !EVIDENCE_SHOT_PATH_RE.test(e.shotPath)) return false
  if (!isFiniteNum(e.width) || e.width <= 0) return false
  if (!isFiniteNum(e.height) || e.height <= 0) return false
  if (!isKeepableStamp(e.stamp)) return false
  if (!Array.isArray(e.trail) || e.trail.length > MAX_TRAIL_ENTRIES_PER_NOTE) return false
  return e.trail.every(isKeepableTrailEntry)
}

/** The evidence record, healed to what this build understands — or undefined
 *  when the SHOT itself is unusable, which is the one part that cannot be
 *  repaired (there is no picture to point at). */
export function sanitizeEvidence(value: unknown): AnnotationEvidence | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const e = value as Partial<AnnotationEvidence> & Record<string, unknown>
  const stamp = sanitizeStamp(e.stamp)
  if (!stamp) return undefined
  const candidate: AnnotationEvidence = {
    shotPath: typeof e.shotPath === 'string' ? e.shotPath : '',
    width: isFiniteNum(e.width) ? e.width : 0,
    height: isFiniteNum(e.height) ? e.height : 0,
    stamp,
    trail: sanitizeTrail(e.trail, MAX_TRAIL_ENTRIES_PER_NOTE),
  }
  return isKeepableEvidence(candidate) ? candidate : undefined
}

/**
 * A version's outcome, in the words the USER saw on the button.
 *
 * Testing mode calls the same two decisions Pass and Fail — the machine is one,
 * only the vocabulary changes — and an agent (or a History row) that reads back
 * "APPROVED" for a build the user pressed *Fail*... on is describing a different
 * gesture than the one that happened. One function, because the pane, the
 * History control, the Library and the MCP serializer all have to say the same
 * word.
 *
 * `observations` is how many notes rode an approval. They are recorded, not
 * owed, so an approval carrying them is still a pass — it just says so.
 */
export function verdictLabel(version: CanvasVersion, opts?: { observations?: number }): string {
  const uat = version.mode === 'uat'
  const state = version.verdict?.state
  if (state === undefined) return version.draft ? 'DRAFT' : 'OPEN'
  if (state === 'approved') {
    const base = uat ? 'PASSED' : 'APPROVED'
    return (opts?.observations ?? 0) > 0 ? `${base} WITH OBSERVATIONS` : base
  }
  if (state === 'rejected') return uat ? 'FAILED' : 'REJECTED'
  return state.toUpperCase()
}

const PACK_NAME_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * The name a test pack wears when the user has not given it one.
 *
 * DERIVED, never stored — which is what keeps it honest. A default that was
 * written into the record at capture time would still say "build 4" after the
 * build label changed, and would still name a config the session no longer runs.
 * The user's own name is the only thing persisted (`CanvasVersion.packName`).
 *
 * The date is formatted from a fixed month list rather than through `toLocale*`:
 * this string is compared in tests and read by an agent, and a name that depends
 * on the host's locale is a name two machines disagree about. An unparseable
 * timestamp drops the date segment rather than inventing "today" — a pack
 * labelled with the wrong day is worse than one labelled with none.
 */
export function defaultPackName(args: {
  configName?: string
  title?: string
  buildLabel?: string
  versionId: string
  at: string
}): string {
  const subject = args.configName?.trim() || args.title?.trim() || 'Test'
  const build = args.buildLabel?.trim() || args.versionId
  const t = Date.parse(args.at)
  const parts = [subject, `build ${build}`]
  if (Number.isFinite(t)) {
    const d = new Date(t)
    parts.push(`${d.getDate()} ${PACK_NAME_MONTHS[d.getMonth()]}`)
  }
  const name = parts.join(' · ')
  return Array.from(name).slice(0, MAX_PACK_NAME_CHARS).join('')
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
  /**
   * The page moved (M3 trail): a hashchange, a popstate, or a History API push
   * the bridge wraps. Reported so the trail can say "navigate /checkout" for the
   * in-page routing that never reaches main's `will-frame-navigate` — a SPA
   * changes route a dozen times without a single document navigation.
   *
   * Pathname and hash ONLY. The query string is deliberately absent: it is where
   * applications put tokens, ids and search terms, i.e. the content this whole
   * feature refuses to record. Coalesced and rate-limited in the page (see
   * NAVIGATED_MIN_INTERVAL_MS) so a routing loop cannot become a flood.
   */
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'navigated'; pathname: string; hash: string }
  /**
   * The user typed into a field (M3 trail) — IDENTITY ONLY, once per focus
   * session per target.
   *
   * The value is never carried and there is no shape of this event that could
   * carry it: `hit` is the same role/name/box report the hover chip already
   * gets. The bridge's own key relay states the rule this obeys — relaying what
   * a user types into a page's real inputs would be a keylogger wearing a
   * feature's name — and the "once per focus session" bound is what keeps this
   * from becoming a per-keystroke channel by volume instead of by content.
   */
  | { ns: typeof CANVAS_BRIDGE_NS; type: 'typedInto'; hit: CanvasHitInfo }

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

// ── The ownership lease, and what the Library reads (M4) ────────────────────
//
// THE LEASE IS LIVENESS, NOT A STORED FIELD. A canvas in flight is PRIVATE to
// the live session that rendered it: another live session sees no row, no
// count, no review action. When that session stops being live — the app quit,
// the tile closed, the PTY exited — the canvas becomes OWNERLESS IN FLIGHT: not
// gone, not memorialised, and resumable by any session on the same project.
//
// Resume is EXPLICIT, ATOMIC and FIRST-WINS. Nothing auto-attaches, ever: two
// rounds of adversarial review established that no identity main can infer is
// trustworthy enough to move the user's private review notes on its own, and
// that finding stands. What M4 adds is the compare-and-set — the caller names
// the owner it SAW, and a resume that would land on a different owner is
// refused rather than silently taking whatever is there now.
//
// A COMPLETED canvas is not adoptable at all. It is memorialised into the
// shared project Library, read-only to everyone but its owner: View never
// transfers ownership, and Reopen (which restores obligations) stays the
// owner's.

/** What KIND of artefact a Library row is, in the words the user reads.
 *  Derived from the version's `mode` — design → mockup, plan → plan, uat →
 *  pack — never stored, so a row can never disagree with its versions. */
export type LibraryRowKind = 'mockup' | 'plan' | 'pack'

export function libraryRowKindOf(mode: CanvasMode): LibraryRowKind {
  return mode === 'uat' ? 'pack' : mode === 'plan' ? 'plan' : 'mockup'
}

/** Which typed tab a Library query is on. */
export type CanvasLibraryTab = 'all' | LibraryRowKind

/** Which chip a Library query has applied. */
export type CanvasLibraryFilter = 'needs-you' | 'open' | 'signed-off' | 'archived'

/**
 * One ARTEFACT RUN in the project Library.
 *
 * Artefact-level, not canvas-level: one canvas accumulates several artefacts
 * (a mockup run, then a plan, then a test pack), and a row per canvas could
 * only ever describe the newest of them while the others became invisible.
 *
 * Everything here is a LABEL, composed in main and sanitized there. None of it
 * is a key: `canvasId` + `anchorVersionId` are what an action is addressed by,
 * and every mutating channel re-checks ownership itself.
 */
export interface CanvasLibraryRow {
  canvasId: string
  /** Latest version of the artefact run this row represents — the id every
   *  row action (archive, delete, view) is addressed by. */
  anchorVersionId: string
  kind: LibraryRowKind
  /** packName ?? canvas title ?? 'Untitled'. */
  title: string
  /** `verdictLabel(anchor, { observations })` — derived strictly from recorded
   *  state, so the badge and the History row can never disagree. */
  verdict: string
  /** What is owed, in plain words ('v2 awaiting review', 'N notes with the
   *  agent', 'N unsent notes'). ABSENT when nothing is owed — never the empty
   *  string, so the renderer has nothing to special-case. */
  owed?: string
  archived: boolean
  completed: boolean
  /** The config's display name, resolved AT READ from `configId` against
   *  configs.json (fallback: the label recorded at spawn). Absent when neither
   *  is known — never a placeholder. */
  configName?: string
  /** The NEWEST activity stamp on the run. `when` is always present; the two
   *  labels are display-only and absent when unknown. */
  audit: { account?: string; sessionLabel?: string; when: string }
  /** 'v8' for a mockup or plan, 'build 5' for a pack. */
  versionLabel: string
  noteCount: number
  /** Pack rows only: up to six note summaries with their shot paths, so the
   *  Library can lazily thumb the evidence without a second listing call. */
  evidence?: Array<{ note: string; route?: string; at: string; shotPath?: string }>
  ownedByThisSession: boolean
  /** `completed && !ownedByThisSession` — the row offers View and nothing else.
   *  Composed in main so the renderer never has to derive a permission. */
  readOnly: boolean
  updatedAt: string
}

/** What `canvas:libraryList` answers. `truncated` is honest: tabs, filters and
 *  the query are all applied in MAIN, so it means "more matched than fit". */
export interface CanvasLibraryResult {
  rows: CanvasLibraryRow[]
  truncated: boolean
}

/**
 * One OWNERLESS IN-FLIGHT canvas this session could resume.
 *
 * `expectedOwnerSessionId` is the compare-and-set token: it is the owner the
 * caller SAW when the row was listed, and `canvas:resume` refuses when the
 * record no longer names it. That is what makes first-wins mean something — the
 * loser of a race is told 'changed' instead of taking a canvas somebody else
 * has already picked up and started working in.
 */
export interface ResumableRow {
  canvasId: string
  /** canvas title ?? packName ?? the conversation short id. */
  title: string
  kind: LibraryRowKind
  noteCount: number
  lastRenderedAt: string
  configName?: string
  expectedOwnerSessionId: string
}

/** Why a resume was refused. A CLOSED vocabulary: the renderer turns each into
 *  one plain line, and nothing free-text crosses the boundary. */
export type CanvasResumeRefusal = 'owner-live' | 'changed' | 'completed' | 'gone'

export interface CanvasResumeResult {
  ok: boolean
  reason?: CanvasResumeRefusal
  /** The caller's canvas state after a successful resume — the resumed canvas
   *  is now their CURRENT one, so the pane can open it without a second read. */
  state?: CanvasState
}

/** Why a dismiss was refused. Closed, for the same reason. */
export type CanvasDismissRefusal = 'owner-live' | 'not-eligible'

export interface CanvasDismissResult {
  ok: boolean
  reason?: CanvasDismissRefusal
}

/**
 * One row of the canvas LIBRARY — every canvas on this machine, not just the
 * ones the asking session could resume.
 *
 * The library exists because nothing was ever removable: `renderVersion` only
 * ever appends, and no code path deleted a canvas or a version, so every canvas
 * a user had ever rendered accumulated forever and surfaced in the resume list
 * of every new session. That is a housekeeping surface, NOT an authorization
 * one — listing a canvas here never binds it to a session (that is still
 * `resumeCanvasForSession`, which the user drives). Everything on this row is a
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
  /**
   * The TEST PACK's name and the build it was run against (M3), for uat rows.
   *
   * `packName` is the user's own name when they set one; the Library composes
   * the generated default from `defaultPackName` otherwise, which is why the
   * default is not stored. `buildLabel` is the agent's label for the build under
   * test, from the version's own source record.
   */
  packName?: string
  buildLabel?: string
  /** True when the session that owns it is one of the currently-open tiles — the
   *  UI warns before deleting a canvas that is on screen right now. */
  ownedByOpenSession?: boolean
  /** True when the ASKING session owns this canvas. DISPLAY ONLY — the in-pane
   *  switcher offers only your own canvases, while the library shows the whole
   *  project. It grants nothing: ownership is the record's own `sessionId`, and
   *  every mutating channel re-checks it at the seam. */
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
   * How many rounds on this canvas are LIVE — submitted, not yet settled.
   *
   * Replaces the old `closeableNoteCount`, which existed to label a bulk
   * close-out button that no longer exists: notes have no per-note controls in
   * the settled machine, and what the row needs to say is simply whether a round
   * is still in flight. `undefined` for an unreadable store, exactly like the
   * counts above — "no live rounds" and "could not tell" must never render the
   * same.
   */
  liveRoundCount?: number
  /**
   * The phase of the canvas's most recent live artefact, derived (never stored)
   * by `artifactPhaseOf` after the settle rules have run — so the Library's
   * owed-text and the pane's status line are the same answer computed once.
   */
  phase?: ArtifactPhase['kind']
  /** A ready-marked render on this canvas awaits the user's first review
   *  (#366). From the canvas record, so it is always present when true. */
  awaitingReview?: boolean
  awaitingReviewAt?: string
  /** Rounds on this canvas waiting on the USER's verdicts — submitted reviews
   *  where every remaining note is addressed (#364). `undefined` when the
   *  review store could not be read, same rule as openReviewCount. */
  verdictRounds?: number
  /** The subject was signed off (#476). From the canvas record, so it is
   *  always present when true — the row shows the Completed badge and offers
   *  View/Reopen instead of the working controls. */
  completed?: CanvasCompletion
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
  /**
   * WHERE the page says it is, and what it calls itself (M3).
   *
   * The state stamp's route and title come from here rather than from a second
   * round-trip, because a stamp has to describe the SAME instant the tree does.
   * Pathname and hash only — never the query string, for the reason the
   * `navigated` event gives. Page-reported, so it is capped and cleaned at the
   * trust boundary and marked as the page's word wherever it is shown.
   */
  page?: { pathname: string; hash: string; title: string }
  /**
   * The `ref` of the node holding keyboard focus, when the page reported one.
   *
   * A ref rather than a description, so the stamp's "focused" chip resolves
   * against the tree in the same capture instead of carrying a second, possibly
   * disagreeing, copy of the element's identity.
   */
  focusedRef?: string
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
