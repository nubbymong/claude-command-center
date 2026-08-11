// Agent Canvas — semantic-snapshot wire format (spec §4.1).
//
// Verbose a11y trees are the dominant token cost of text-based review, so
// `canvas_snapshot` sends the agent a COMPACT INDENTED TEXT serialization
// (modeled on Playwright MCP's aria snapshot), not JSON — one line per node,
// ref-keyed, box / state / styles / issues inline. JSON stays available behind
// an explicit flag for tooling.
//
//   snapshot v3  viewport=1440x900 dpr=2
//   - button "Save" [ref=e12] [ux=settings-save] [box=840,512,64,28]
//     - issue: target-size 28px, needs 44px
//
// Pure and dependency-free so it runs in the main process (the MCP tool) and is
// trivially unit-tested.

import type { AxeIssue, Rect, SemanticSnapshot, SnapshotNode } from './canvas'

export interface SerializeOptions {
  /** 'text' (default) — the compact tree. 'json' — the raw SemanticSnapshot. */
  format?: 'text' | 'json'
}

export function serializeSnapshot(snapshot: SemanticSnapshot, opts?: SerializeOptions): string {
  if (opts?.format === 'json') return JSON.stringify(snapshot, null, 2)
  const { width, height, dpr } = snapshot.viewport
  const lines: string[] = [`snapshot ${snapshot.versionId}  viewport=${r(width)}x${r(height)} dpr=${dpr}`]
  walk(snapshot.root, 0, lines)
  return lines.join('\n')
}

function walk(node: SnapshotNode, depth: number, lines: string[]): void {
  const indent = '  '.repeat(depth)
  lines.push(indent + nodeLine(node))
  for (const issue of node.issues ?? []) lines.push(indent + '  ' + issueLine(issue))
  for (const child of node.children) walk(child, depth + 1, lines)
}

function nodeLine(node: SnapshotNode): string {
  const parts = ['-']
  if (node.role) parts.push(node.role)
  if (node.name) parts.push(`"${escape(node.name)}"`)
  parts.push(`[ref=${node.ref}]`)
  if (node.uxId) parts.push(`[ux=${node.uxId}]`)
  parts.push(`[box=${boxTokens(node.box)}]`)
  parts.push(...stateTokens(node.state))
  parts.push(...styleTokens(node.styles))
  return parts.join(' ')
}

function issueLine(issue: AxeIssue): string {
  // "issue: target-size 28px, needs 44px"
  const measured = issue.measured ? ` ${issue.measured}` : ''
  const needed = issue.needed ? `, needs ${issue.needed}` : ''
  return `- issue: ${issue.rule}${measured}${needed}`
}

function boxTokens(box: Rect): string {
  return `${r(box.x)},${r(box.y)},${r(box.width)},${r(box.height)}`
}

function stateTokens(state: SnapshotNode['state']): string[] {
  if (!state) return []
  const out: string[] = []
  if (state.type) out.push(`[type=${state.type}]`)
  if (state.checked) out.push('[checked]')
  if (state.disabled) out.push('[disabled]')
  if (state.value != null && state.value !== '') out.push(`[value="${escape(state.value)}"]`)
  if (state.ariaInvalid) out.push('[aria-invalid]')
  // Opacity is only interesting when it's actually reducing visibility.
  if (state.opacity != null && state.opacity < 1) out.push(`[opacity=${round2(state.opacity)}]`)
  return out
}

function styleTokens(styles: SnapshotNode['styles']): string[] {
  if (!styles) return []
  // Stable order so the wire output is deterministic (snapshot diffs, tests).
  return Object.keys(styles)
    .sort()
    .map((k) => `[${k}=${styles[k]}]`)
}

/** A style/name value can contain `]` or a newline; keep each token on one line
 *  and never let a value close the bracket early. */
function escape(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/"/g, '\\"')
}

function r(n: number): number {
  return Math.round(Number.isFinite(n) ? n : 0)
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100
}
