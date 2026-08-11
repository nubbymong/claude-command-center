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

/** Matched to the bridge's own caps, so a well-behaved page never trips them. */
export const DEFAULT_SNAPSHOT_LIMITS: SanitizeLimits = {
  maxNodes: 4000,
  maxDepth: 64,
  maxChildren: 500,
  maxIssuesPerNode: 20,
  maxStyleEntries: 24,
  maxText: 200,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function str(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  // Control characters (newlines included) would break the one-line-per-node
  // wire format, and are how injected text forges structure.
  const clean = value.replace(/[\x00-\x1F\x7F]/g, ' ')
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean
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

function styles(value: unknown, limits: SanitizeLimits): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, string> = {}
  let count = 0
  for (const key of Object.keys(value)) {
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
  return count > 0 ? out : undefined
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
}

function node(value: unknown, depth: number, budget: Budget, limits: SanitizeLimits): SnapshotNode | null {
  if (!isRecord(value)) return null
  if (budget.nodes >= limits.maxNodes) {
    budget.truncated = true
    return null
  }
  budget.nodes++

  const out: SnapshotNode = {
    ref: str(value.ref, 32) || `e${budget.nodes}`,
    role: str(value.role, 64),
    name: str(value.name, limits.maxText),
    box: rect(value.box),
    children: [],
  }
  const uxId = str(value.uxId, 128)
  if (uxId) out.uxId = uxId
  const nodeStyles = styles(value.styles, limits)
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

const EMPTY_ROOT: SnapshotNode = { ref: 'e0', role: 'document', name: '', box: { x: 0, y: 0, width: 0, height: 0 }, children: [] }

/**
 * Coerce whatever came back from the content frame into a CanvasSnapshotResult.
 * Never throws: a malformed payload degrades to an empty tree rather than
 * failing the tool call, and `truncated` records that something was dropped.
 */
export function sanitizeSnapshotResult(raw: unknown, limits: SanitizeLimits = DEFAULT_SNAPSHOT_LIMITS): CanvasSnapshotResult {
  const source = isRecord(raw) ? raw : {}
  const viewportRaw = isRecord(source.viewport) ? source.viewport : {}
  const budget: Budget = { nodes: 0, truncated: false }
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
  const analysisError = str(source.analysisError, 300)
  if (analysisError) out.analysisError = analysisError
  return out
}
