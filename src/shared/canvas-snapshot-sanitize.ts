// The trust boundary for snapshot data.
//
// A snapshot is BUILT BY THE PAGE. It travels content frame → renderer → main →
// the agent's context, so by the time main sees it, it is untrusted input that a
// hostile (or merely broken) document controls the shape of: unbounded depth,
// millions of nodes, megabyte strings, structures that are cyclic — structured
// clone carries cycles happily, and the serializer would recurse forever on one.
//
// Everything from the frame goes through here first. The result is a value that
// matches CanvasSnapshotResult by construction, with every string bounded and
// every number finite. Nothing is trusted enough to pass through unexamined.

import type { AxeIssue, CanvasSnapshotResult, Rect, SnapshotNode } from './canvas'

export interface SanitizeLimits {
  maxNodes: number
  maxDepth: number
  maxChildren: number
  maxIssuesPerNode: number
  maxStyleEntries: number
  maxText: number
  /** Ceiling on the WHOLE result, not on any one part of it. See below. */
  maxChars: number
}

/**
 * Matched to the bridge's own caps, so a well-behaved page never trips them.
 *
 * `maxChildren` used to be 500 while the bridge had no per-node children cap at
 * all — the comment above was simply false. An honest 600-row list lost 100 rows,
 * and the capture note blamed "the snapshot node limit", which was not the limit
 * that fired. It is now aligned with `maxNodes`, which is the real bound: the
 * node budget is checked before every node, so total output is capped whatever a
 * single parent's fan-out is, and a separate smaller breadth cap bought nothing
 * except silent data loss on ordinary pages.
 */
export const DEFAULT_SNAPSHOT_LIMITS: SanitizeLimits = {
  maxNodes: 4000,
  maxDepth: 64,
  maxChildren: 4000,
  maxIssuesPerNode: 20,
  maxStyleEntries: 24,
  maxText: 200,
  // Every other limit here is per-node, and per-node limits MULTIPLY: 4,000
  // nodes each legally carrying a name, a uxId, 20 issues and 24 styles is
  // ~48 M characters, all of it structured-cloned across two process hops and
  // held four times over per session. 19.9 KB of page produced a 28 MB IPC
  // message that way — a 1,439x amplification of what the page actually spent.
  //
  // The serializer will emit at most MAX_SNAPSHOT_CHARS (512,000) of it, so
  // everything above that is carried at full cost and then discarded. Two times
  // that leaves room for the sanitised object to hold fields the text form
  // omits, and still cuts the amplification by a factor of ~28. A snapshot that
  // hits this is marked `truncated`, exactly like one that hits `maxNodes`.
  maxChars: 1_024_000,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Return a string that owns its own characters.
 *
 * V8 answers `slice()` with a SlicedString — a *view* that keeps the entire
 * parent alive — and wrapping that view in a concatenation does not release it
 * either (both measured: 200,000 kept results of 201 characters each ran a
 * 1.4 GB heap out of memory). A snapshot retains up to 4,000 nodes × ~85 of
 * these, so a view onto a normalised megabyte is the whole difference between
 * a snapshot and a dead window. Copying ≤ 200 characters is free.
 */
function detach(value: string): string {
  return value.split('').join('')
}

/** Cut to `max` without splitting a surrogate pair. A lone surrogate is not
 *  text; it survives JSON and structured clone as a replacement character and
 *  makes the wire output lie about what the page contained. */
function clip(value: string, max: number): string {
  let end = max - 1
  const lastKept = value.charCodeAt(end - 1)
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1
  return detach(value.slice(0, end) + '…')
}

/** Anything a reader — or a model — could take for a line break or for
 *  invisible structure. \x00-\x1F is NOT enough: U+2028/U+2029/U+0085 are line
 *  terminators too, and format characters (bidi overrides, zero-width joiners)
 *  let text claim to be something it is not. Cc, Cf, Zl and Zp cover all of it. */
function scrub(value: string): string {
  return value.normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
}

function str(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length === 0) return ''
  // Normalise BEFORE capping, and that order is deliberate: the serializer
  // normalises too, and it used to be the FIRST to do so, so a string that was
  // cap-legal at 200 characters here reached the wire at ~3,600.
  //
  // But normalising the whole value is how the fix for that became the worse
  // bug. NFKC expands one codepoint into up to 18, this runs ~85 times per node
  // on the renderer's UI THREAD, and a prefix bound of `max * 24` in front of
  // that expansion is an effective bound of `max * 432` — 36 KB of page was
  // enough to kill the window outright. So normalise a PREFIX and cap after the
  // expansion, not before.
  //
  // The prefix has to be grown rather than fixed because composition SHRINKS:
  // Hangul L+V+T collapses 3 units to 1, and NFKC folds astral codepoints down
  // to BMP ones. A fixed `max * 2` would silently clip such a string short of
  // its cap. Growing while the result is too short is exact for every real
  // string; the iteration bound is what stops a page engineered to sit just
  // under the cap from walking a megabyte, at the cost of clipping it early.
  let end = Math.min(value.length, max * 2)
  let clean = scrub(value.slice(0, end))
  for (let grow = 0; grow < 4 && clean.length < max && end < value.length; grow++) {
    end = Math.min(value.length, end * 2)
    clean = scrub(value.slice(0, end))
  }
  if (clean.length > max) return clip(clean, max)
  // `scrub` hands back its input unchanged when the value is already normalised
  // and control-free, so on this path `clean` can still BE the page's string —
  // or a view onto it. Detach only when a cut actually happened; otherwise the
  // string is its own bounded self and copying it buys nothing.
  return value.length > end ? detach(clean) : clean
}

/**
 * `str` for a field of a page-supplied record, memoised on that record.
 *
 * Same asymmetry `styleMemo` closes, one level down. Structured clone preserves
 * object IDENTITY, so ONE node object referenced 4,000 times costs the page a
 * single string and costs us 4,000 normalisations of it — the shape that made
 * the OOM cheap to trigger. Keyed by the owning record rather than by the
 * string, because the string is unbounded and page-controlled and has no
 * business being a map key.
 */
function field(record: Record<string, unknown>, key: string, max: number, budget: Budget): string {
  // `max` is part of the key so a caller that reads one field at two different
  // caps can never be served the longer answer — a memo is not allowed to hand
  // back a string that outruns the bound its caller asked for.
  const memoKey = `${max}:${key}`
  let byKey = budget.strMemo.get(record)
  if (byKey === undefined) {
    byKey = new Map()
    budget.strMemo.set(record, byKey)
  } else {
    const hit = byKey.get(memoKey)
    if (hit !== undefined) return hit
  }
  const out = str(record[key], max)
  byKey.set(memoKey, out)
  return out
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function rect(value: unknown): Rect {
  if (!isRecord(value)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: num(value.x), y: num(value.y), width: num(value.width), height: num(value.height) }
}

function issues(value: unknown, budget: Budget, limits: SanitizeLimits): AxeIssue[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: AxeIssue[] = []
  for (const raw of value.slice(0, limits.maxIssuesPerNode)) {
    if (!isRecord(raw)) continue
    const rule = field(raw, 'rule', 64, budget)
    if (!rule) continue
    out.push({
      rule,
      severity: field(raw, 'severity', 24, budget),
      measured: field(raw, 'measured', 96, budget),
      needed: field(raw, 'needed', 96, budget),
    })
  }
  return out.length > 0 ? out : undefined
}

function styles(value: unknown, budget: Budget, limits: SanitizeLimits): Record<string, string> | undefined {
  if (!budget.allowStyles) return undefined
  if (!isRecord(value)) return undefined
  // Structured clone preserves object IDENTITY, so one huge styles object
  // referenced from every node costs the page almost nothing on the wire while
  // costing us the full scan per node. Memoise per snapshot and that asymmetry
  // — the thing that made the attack cheap — disappears.
  const cached = budget.styleMemo.get(value)
  if (cached !== undefined) return cached.value

  const out: Record<string, string> = {}
  let count = 0
  // Bound the keys EXAMINED, not the keys accepted. Rejected keys used to be
  // free — they never advanced `count`, so a map of junk names was walked in
  // full for every node, and 0.3 MB of payload froze the renderer's UI thread
  // for 30 s: longer than either capture timeout, on the thread that runs
  // React, every terminal, and all IPC.
  const keys = Object.keys(value)
  const examine = keys.length > limits.maxStyleEntries * 8 ? keys.slice(0, limits.maxStyleEntries * 8) : keys
  for (const key of examine) {
    if (count >= limits.maxStyleEntries) break
    const name = str(key, 48)
    // A style name is a CSS property, never arbitrary page text. The shape
    // already excludes `__proto__` (no underscores); the two remaining
    // prototype-shaped names are rejected by hand so the map can never carry one.
    if (!/^[a-z-]{1,48}$/.test(name)) continue
    if (name === 'constructor' || name === 'prototype') continue
    const styleValue = str(value[key], limits.maxText)
    if (!styleValue) continue
    out[name] = styleValue
    count++
  }
  const result = count > 0 ? out : undefined
  budget.styleMemo.set(value, { value: result })
  return result
}

function state(value: unknown, budget: Budget, limits: SanitizeLimits): SnapshotNode['state'] {
  if (!isRecord(value)) return undefined
  const out: NonNullable<SnapshotNode['state']> = {}
  const type = field(value, 'type', 32, budget)
  if (type) out.type = type
  if (value.checked === true) out.checked = true
  if (value.disabled === true) out.disabled = true
  const fieldValue = field(value, 'value', limits.maxText, budget)
  if (fieldValue) out.value = fieldValue
  if (value.ariaInvalid === true) out.ariaInvalid = true
  if (value.srOnly === true) out.srOnly = true
  if (typeof value.opacity === 'number' && Number.isFinite(value.opacity)) {
    out.opacity = Math.max(0, Math.min(1, value.opacity))
  }
  return Object.keys(out).length > 0 ? out : undefined
}

interface Budget {
  nodes: number
  /** Characters emitted so far, across the whole result. */
  chars: number
  truncated: boolean
  /** Per-snapshot, so this stays a pure function across calls. Wrapped because
   *  `undefined` is a real result ("no usable styles") and WeakMap cannot tell
   *  that from a miss. */
  styleMemo: WeakMap<object, { value: Record<string, string> | undefined }>
  /** Per-snapshot memo for `field`. See its comment for why it exists. */
  strMemo: WeakMap<object, Map<string, string>>
  /** False for an unscoped capture — see SanitizeContext.scoped. */
  allowStyles: boolean
}

/**
 * What a node costs on the wire, as an UPPER bound.
 *
 * It has to be an upper bound rather than an estimate, because the gap is
 * attacker-controlled: the JSON key names around a field are fixed, so a node
 * carrying twenty issues with empty values costs ~1,150 characters of pure
 * structure while its *values* cost twenty. Charging only the values would let
 * a page buy roughly five times the budget it was sold. So every constant here
 * covers the punctuation and key names the serializer will emit around the
 * value, and the node base covers the ref, the four box numbers at their
 * longest, and `"children":[]`.
 */
/** Each constant is the fixed JSON around one field — its quotes, its key name
 *  and its separator — measured, not guessed. Being tight matters as much as
 *  being an upper bound: a padded constant spends an honest page's budget on
 *  punctuation it never sends and truncates a snapshot that fitted. */
function weigh(value: SnapshotNode): number {
  // `{"ref":"…","role":"…","name":"…","box":{"x":…,"y":…,"width":…,"height":…},"children":[]},`
  let total = 82 + value.ref.length + value.role.length + value.name.length
  total += num2str(value.box.x) + num2str(value.box.y) + num2str(value.box.width) + num2str(value.box.height)
  if (value.uxId !== undefined) total += 10 + value.uxId.length
  const nodeState = value.state
  if (nodeState) {
    total += 11
    if (nodeState.type !== undefined) total += 10 + nodeState.type.length
    if (nodeState.value !== undefined) total += 11 + nodeState.value.length
    if (nodeState.checked !== undefined) total += 15
    if (nodeState.disabled !== undefined) total += 16
    if (nodeState.ariaInvalid !== undefined) total += 19
    if (nodeState.srOnly !== undefined) total += 14
    if (nodeState.opacity !== undefined) total += 11 + num2str(nodeState.opacity)
  }
  if (value.styles) {
    total += 12
    for (const key of Object.keys(value.styles)) total += 6 + key.length + value.styles[key].length
  }
  if (value.issues) {
    total += 12
    for (const issue of value.issues) {
      total += 52 + issue.rule.length + issue.severity.length + issue.measured.length + issue.needed.length
    }
  }
  return total
}

/** How many characters this number occupies once serialized. `1e21` is four,
 *  `0.1234567890123456` is eighteen, and a page picks which. */
function num2str(value: number): number {
  return String(value).length
}

function node(value: unknown, depth: number, budget: Budget, limits: SanitizeLimits): SnapshotNode | null {
  if (!isRecord(value)) return null
  // Two ceilings, and the character one is the load-bearing half: `maxNodes`
  // alone bounds the COUNT while leaving each node free to be enormous.
  // Charged after the node is built, so the result can overshoot by at most one
  // node — bounded by the per-node limits, which is what they are good for.
  if (budget.nodes >= limits.maxNodes || budget.chars >= limits.maxChars) {
    budget.truncated = true
    return null
  }
  budget.nodes++

  // Refs are ASSIGNED here, never accepted. Shape-checking a page-supplied ref
  // still let it collide with ours ('e1' twice, or 'e01' beside 'e1'), and the
  // honest bridge numbers its own nodes anyway — so accepting one buys nothing.
  const out: SnapshotNode = {
    ref: `e${budget.nodes}`,
    role: field(value, 'role', 64, budget),
    name: field(value, 'name', limits.maxText, budget),
    box: rect(value.box),
    children: [],
  }
  const uxId = field(value, 'uxId', 128, budget)
  if (uxId) out.uxId = uxId
  const nodeStyles = styles(value.styles, budget, limits)
  if (nodeStyles) out.styles = nodeStyles
  const nodeState = state(value.state, budget, limits)
  if (nodeState) out.state = nodeState
  const nodeIssues = issues(value.issues, budget, limits)
  if (nodeIssues) out.issues = nodeIssues
  budget.chars += weigh(out)

  // Depth is the cycle guard: a self-referencing tree cannot outrun it, and the
  // node budget bounds the fan-out case.
  if (depth >= limits.maxDepth) {
    if (Array.isArray(value.children) && value.children.length > 0) budget.truncated = true
    return out
  }
  if (Array.isArray(value.children)) {
    if (value.children.length > limits.maxChildren) budget.truncated = true
    for (const child of value.children.slice(0, limits.maxChildren)) {
      const walked = node(child, depth + 1, budget, limits)
      if (walked) out.children.push(walked)
    }
  }
  return out
}

/** The only analysis-failure codes that may leave this function. */
const ANALYSIS_CODES = new Set(['load-failed', 'run-failed', 'unavailable'])

const EMPTY_ROOT: SnapshotNode = { ref: 'e0', role: 'document', name: '', box: { x: 0, y: 0, width: 0, height: 0 }, children: [] }

/**
 * Coerce whatever came back from the content frame into a CanvasSnapshotResult.
 * Never throws: a malformed payload degrades to an empty tree rather than
 * failing the tool call, and `truncated` records that something was dropped.
 */
export interface SanitizeContext {
  /**
   * Whether the capture that produced this actually ASKED for a scope.
   *
   * Styles are the dominant token cost, and the contract the tool advertises to
   * the model is that only scoped nodes carry them. That was enforced solely by
   * the bridge — i.e. by code inside the page, which a hostile document simply
   * replaces. A forged reply put 24 styles on all 4,000 nodes of an UNSCOPED
   * capture, which was ~84% of the payload that serialized to 43.8 MB.
   *
   * Defaults to false: this is the one place that knows the honest answer, so it
   * fails closed and a caller that forgets to say gets the cheap tree, not the
   * expensive one.
   */
  scoped?: boolean
}

export function sanitizeSnapshotResult(
  raw: unknown,
  limits: SanitizeLimits = DEFAULT_SNAPSHOT_LIMITS,
  context: SanitizeContext = {},
): CanvasSnapshotResult {
  const source = isRecord(raw) ? raw : {}
  const viewportRaw = isRecord(source.viewport) ? source.viewport : {}
  const budget: Budget = {
    nodes: 0,
    chars: 0,
    truncated: false,
    styleMemo: new WeakMap(),
    strMemo: new WeakMap(),
    allowStyles: context.scoped === true,
  }
  const root = node(source.root, 0, budget, limits) ?? { ...EMPTY_ROOT }

  const out: CanvasSnapshotResult = {
    viewport: {
      width: num(viewportRaw.width),
      height: num(viewportRaw.height),
      dpr: num(viewportRaw.dpr) || 1,
    },
    root,
  }

  if (Array.isArray(source.unmatchedScope)) {
    const unmatched = source.unmatchedScope
      .slice(0, 50)
      .map((id) => str(id, 128))
      .filter((id) => id.length > 0)
    if (unmatched.length > 0) out.unmatchedScope = unmatched
  }
  if (source.truncated === true || budget.truncated) out.truncated = true
  // Closed set, not free text: this string is the one field that reaches the
  // agent OUTSIDE the untrusted envelope (as a capture note), so the page must
  // not be able to author it. Anything unrecognised becomes the generic code.
  const analysisError = str(source.analysisError, 32)
  if (analysisError) out.analysisError = ANALYSIS_CODES.has(analysisError) ? analysisError : 'unavailable'
  return out
}
