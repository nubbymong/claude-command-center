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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Cut to `max` without splitting a surrogate pair. A lone surrogate is not
 *  text; it survives JSON and structured clone as a replacement character and
 *  makes the wire output lie about what the page contained. */
function clip(value: string, max: number): string {
  let end = max - 1
  const lastKept = value.charCodeAt(end - 1)
  if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1
  return value.slice(0, end) + '…'
}

function str(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  // Bound the WORK before doing any of it. A page can put a megabyte in every
  // field, and scanning all of it to keep 200 characters cost ~0.67 ms per KB
  // of wire — on the renderer's UI thread. NFKC can expand one codepoint into
  // 18, so a prefix that survives the worst expansion is still a constant.
  const head = value.length > max * 24 ? value.slice(0, max * 24) : value
  // Normalise BEFORE capping, and this order is the whole point. The serializer
  // normalises too, and it used to be the FIRST to do so — so a string that was
  // cap-legal at 200 characters here expanded to ~3,600 on the wire, and 4,000
  // nodes of that threw RangeError out of the main process after ~9 s of
  // synchronous work and a 3 GB heap spike. Normalising first makes the
  // serializer's pass idempotent and makes this cap mean what it says.
  const clean = head
    .normalize('NFKC')
    // Anything a reader — or a model — could take for a line break or for
    // invisible structure. \x00-\x1F is NOT enough: U+2028/U+2029/U+0085 are line
    // terminators too, and format characters (bidi overrides, zero-width joiners)
    // let text claim to be something it is not. Cc, Cf, Zl and Zp cover all of it.
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
  return clean.length > max ? clip(clean, max) : clean
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function rect(value: unknown): Rect {
  if (!isRecord(value)) return { x: 0, y: 0, width: 0, height: 0 }
  return { x: num(value.x), y: num(value.y), width: num(value.width), height: num(value.height) }
}

function issues(value: unknown, limits: SanitizeLimits): AxeIssue[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: AxeIssue[] = []
  for (const raw of value.slice(0, limits.maxIssuesPerNode)) {
    if (!isRecord(raw)) continue
    const rule = str(raw.rule, 64)
    if (!rule) continue
    out.push({
      rule,
      severity: str(raw.severity, 24),
      measured: str(raw.measured, 96),
      needed: str(raw.needed, 96),
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

function state(value: unknown, limits: SanitizeLimits): SnapshotNode['state'] {
  if (!isRecord(value)) return undefined
  const out: NonNullable<SnapshotNode['state']> = {}
  const type = str(value.type, 32)
  if (type) out.type = type
  if (value.checked === true) out.checked = true
  if (value.disabled === true) out.disabled = true
  const fieldValue = str(value.value, limits.maxText)
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
  truncated: boolean
  /** Per-snapshot, so this stays a pure function across calls. Wrapped because
   *  `undefined` is a real result ("no usable styles") and WeakMap cannot tell
   *  that from a miss. */
  styleMemo: WeakMap<object, { value: Record<string, string> | undefined }>
  /** False for an unscoped capture — see SanitizeContext.scoped. */
  allowStyles: boolean
}

function node(value: unknown, depth: number, budget: Budget, limits: SanitizeLimits): SnapshotNode | null {
  if (!isRecord(value)) return null
  if (budget.nodes >= limits.maxNodes) {
    budget.truncated = true
    return null
  }
  budget.nodes++

  // Refs are ASSIGNED here, never accepted. Shape-checking a page-supplied ref
  // still let it collide with ours ('e1' twice, or 'e01' beside 'e1'), and the
  // honest bridge numbers its own nodes anyway — so accepting one buys nothing.
  const out: SnapshotNode = {
    ref: `e${budget.nodes}`,
    role: str(value.role, 64),
    name: str(value.name, limits.maxText),
    box: rect(value.box),
    children: [],
  }
  const uxId = str(value.uxId, 128)
  if (uxId) out.uxId = uxId
  const nodeStyles = styles(value.styles, budget, limits)
  if (nodeStyles) out.styles = nodeStyles
  const nodeState = state(value.state, limits)
  if (nodeState) out.state = nodeState
  const nodeIssues = issues(value.issues, limits)
  if (nodeIssues) out.issues = nodeIssues

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
  const budget: Budget = { nodes: 0, truncated: false, styleMemo: new WeakMap(), allowStyles: context.scoped === true }
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
