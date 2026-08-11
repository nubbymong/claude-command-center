// SemanticSnapshot capture (spec §4).
//
// One walk of the rendered document produces the tree, the measurement findings
// and the element↔node index that axe results are joined onto. Scoping is by
// `data-ux-id` — the anchor the authoring contract asks for — and is what keeps
// a snapshot affordable: styles ride only on scoped nodes (§4.1).

import type { AxeIssue, CanvasSnapshotOptions, CanvasSnapshotResult, SnapshotNode } from '../../../shared/canvas'
import { ensureAnalysis, withRunTimeout, type AnalysisApi, type AxeNodeResult, type AxeViolation } from './analysis-loader'
import { addOverlapIssues, measurementIssues, type Candidate } from './issues'
import { boxOf, curatedStyles, directText, effectiveOpacity, isSrOnly, isVisible, resetStyleCache, stateOf } from './measure'
import { isInteractive, isMeaningful, isSkipped, nameOf, roleOf, squash } from './semantics'

const MAX_NODES = 4000
const MAX_DEPTH = 64

/**
 * The axe rules worth their runtime here: contrast, and the "this control has no
 * accessible name" family. Everything structural that a reviewer would act on is
 * measured directly instead (issues.ts), and the rest of axe's ~100 rules are
 * noise in a design-review context.
 */
export const AXE_RULES = [
  'color-contrast',
  'image-alt',
  'button-name',
  'link-name',
  'input-button-name',
  'input-image-alt',
  'label',
  'select-name',
  'aria-command-name',
  'aria-toggle-field-name',
  'aria-input-field-name',
]

interface WalkContext {
  includeStyles: boolean
  candidates: Candidate[]
  byElement: Map<Element, SnapshotNode>
  nextRef: number
  truncated: boolean
}

/** Failure CODES, never messages: analysisError is surfaced to the agent as a
 *  capture note outside the untrusted envelope, so its vocabulary is closed
 *  (canvas-snapshot-sanitize.ts enforces the same set on arrival). */
type AnalysisFailure = 'load-failed' | 'run-failed'

function walk(el: Element, ctx: WalkContext, depth: number): SnapshotNode | SnapshotNode[] | null {
  if (depth > MAX_DEPTH) return null
  if (isSkipped(el)) return null

  // Refs are allocated on the way DOWN so they run in document order: the agent
  // reads the serialized tree top to bottom, and refs that count downward with it
  // are the difference between a readable snapshot and a lookup table.
  let node: SnapshotNode | null = null
  if (isMeaningful(el) && isVisible(el)) {
    if (ctx.nextRef > MAX_NODES) {
      ctx.truncated = true
    } else {
      const role = roleOf(el)
      const srOnly = isSrOnly(el)
      const opacity = effectiveOpacity(el)
      node = {
        ref: `e${ctx.nextRef++}`,
        role,
        name: nameOf(el),
        box: boxOf(el),
        children: [],
      }
      const uxId = el.getAttribute('data-ux-id')
      if (uxId) node.uxId = uxId
      const state = stateOf(el, { srOnly, opacity })
      if (state) node.state = state
      if (ctx.includeStyles) {
        const styles = curatedStyles(el)
        if (styles) node.styles = styles
      }
      ctx.byElement.set(el, node)
      ctx.candidates.push({
        el,
        node,
        role,
        interactive: isInteractive(el, role),
        srOnly,
        opacity,
        text: directText(el),
      })
    }
  }

  let children: SnapshotNode[] = []
  for (let i = 0; i < el.children.length; i++) {
    if (ctx.nextRef > MAX_NODES) {
      ctx.truncated = true
      break
    }
    const walked = walk(el.children[i], ctx, depth + 1)
    if (walked === null) continue
    if (Array.isArray(walked)) children = children.concat(walked)
    else children.push(walked)
  }

  // A non-semantic wrapper contributes nothing but its children, which are
  // spliced up a level to keep the tree (and its token cost) shallow.
  if (!node) return children
  node.children = children
  return node
}

function resolveScope(ids: string[]): { roots: Element[]; unmatched: string[] } {
  if (ids.length === 0) return { roots: document.body ? [document.body] : [], unmatched: [] }
  // Attribute comparison rather than a [data-ux-id="…"] selector: exact, needs no
  // CSS.escape, and immune to hostile characters in page-authored ids.
  const wanted = new Set(ids)
  const found = new Map<string, Element>()
  const all = document.querySelectorAll('[data-ux-id]')
  for (let i = 0; i < all.length; i++) {
    const id = all[i].getAttribute('data-ux-id')
    if (id && wanted.has(id) && !found.has(id)) found.set(id, all[i])
  }
  return {
    roots: ids.filter((id) => found.has(id)).map((id) => found.get(id) as Element),
    unmatched: ids.filter((id) => !found.has(id)),
  }
}

function contrastData(node: AxeNodeResult): { measured: string; needed: string } {
  for (const check of [...(node.any ?? []), ...(node.all ?? [])]) {
    const data = check.data
    if (data && typeof data.contrastRatio === 'number') {
      return {
        measured: `${Math.round(data.contrastRatio * 100) / 100}:1`,
        needed: data.expectedContrastRatio ?? '',
      }
    }
  }
  return { measured: '', needed: '' }
}

function toIssue(violation: AxeViolation, node: AxeNodeResult): AxeIssue {
  const { measured, needed } = contrastData(node)
  return {
    rule: violation.id,
    severity: node.impact || violation.impact || 'moderate',
    measured,
    needed,
  }
}

function elementOf(node: AxeNodeResult): Element | null {
  if (node.element) return node.element
  const selector = node.target?.[0]
  if (typeof selector !== 'string') return null
  try {
    return document.querySelector(selector)
  } catch {
    return null
  }
}

function joinAxe(violations: AxeViolation[], byElement: Map<Element, SnapshotNode>): void {
  for (const violation of violations ?? []) {
    for (const axeNode of violation.nodes ?? []) {
      const el = elementOf(axeNode)
      if (!el) continue
      const node = byElement.get(el)
      if (!node) continue
      const issue = toIssue(violation, axeNode)
      const issues = node.issues ?? []
      if (issues.some((existing) => existing.rule === issue.rule)) continue
      issues.push(issue)
      node.issues = issues
    }
  }
}

export async function captureSnapshot(options: CanvasSnapshotOptions = {}): Promise<CanvasSnapshotResult> {
  const scope = (options.scope ?? []).filter((id) => typeof id === 'string' && id.length > 0)
  let analysis: AnalysisApi | null = null
  let analysisError: AnalysisFailure | undefined

  if (options.analysis !== false) {
    try {
      analysis = await ensureAnalysis()
    } catch {
      analysisError = 'load-failed' satisfies AnalysisFailure
    }
  }

  // One memo per capture: the walk reads each element's computed style several
  // times over, and re-resolving it every time is the difference between a
  // snapshot and a stalled frame on a deep page.
  resetStyleCache()

  const { roots, unmatched } = resolveScope(scope)
  const ctx: WalkContext = {
    includeStyles: scope.length > 0,
    candidates: [],
    byElement: new Map(),
    nextRef: 1,
    truncated: false,
  }

  let children: SnapshotNode[] = []
  for (const rootEl of roots) {
    const walked = walk(rootEl, ctx, 0)
    if (walked === null) continue
    if (Array.isArray(walked)) children = children.concat(walked)
    else children.push(walked)
  }

  const root: SnapshotNode = {
    ref: 'e0',
    role: 'document',
    name: squash(document.title),
    box: document.body ? boxOf(document.body) : { x: 0, y: 0, width: 0, height: 0 },
    children,
  }

  // Run axe FIRST, so contrast coverage is decided by what actually happened.
  // Computing it up front left a hole: a chunk that loaded but whose run then
  // threw meant the measurement pass had already declined flat contrast and axe
  // produced nothing, so nobody checked it — while the capture note claimed
  // coverage. (Two concurrent captures hit this readily: axe is a singleton and
  // rejects with "Axe is already running".)
  let violations: AxeViolation[] | null = null
  if (analysis) {
    try {
      const context = scope.length > 0 && roots.length > 0 ? roots : document
      const result = await withRunTimeout(analysis.run(context, AXE_RULES))
      violations = result.violations
    } catch {
      analysisError = 'run-failed' satisfies AnalysisFailure
    }
  }

  // axe owns flat-background contrast when it ran; the measurement pass then
  // claims only the gradient case, which axe reports as `incomplete` and
  // therefore never fails. When axe did not run, measurement covers both.
  const flatContrast = violations === null
  for (const candidate of ctx.candidates) {
    const issues = measurementIssues(candidate, { flatContrast })
    if (issues.length > 0) candidate.node.issues = (candidate.node.issues ?? []).concat(issues)
  }
  addOverlapIssues(ctx.candidates)

  // Joined after the measurement pass so the dedupe keeps the measured finding
  // when both fire on one node.
  if (violations) joinAxe(violations, ctx.byElement)

  const out: CanvasSnapshotResult = {
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    },
    root,
  }
  if (unmatched.length > 0) out.unmatchedScope = unmatched
  if (ctx.truncated) out.truncated = true
  if (analysisError) out.analysisError = analysisError
  return out
}
