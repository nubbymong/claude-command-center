// SemanticSnapshot capture (spec §4).
//
// One walk of the rendered document produces the tree, the measurement findings
// and the element↔node index that axe results are joined onto. Scoping is by
// `data-ux-id` — the anchor the authoring contract asks for — and is what keeps
// a snapshot affordable: styles ride only on scoped nodes (§4.1).

import type { AxeIssue, CanvasSnapshotOptions, CanvasSnapshotResult, Rect, SnapshotNode } from '../../../shared/canvas'
import { ensureAnalysis, withRunTimeout, type AnalysisApi, type AxeNodeResult, type AxeViolation } from './analysis-loader'
import { addOverlapIssues, measurementIssues, type Candidate } from './issues'
import { boxOf, curatedStyles, directText, effectiveOpacity, isSrOnly, isVisible, resetCaptureCaches, stateOf } from './measure'
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

/** Matches the sanitiser's `maxIssuesPerNode` and `MAX_OVERLAPS_PER_NODE`.
 *  Attributing findings to an ancestor concentrates them, so without a bound a
 *  page of 4,000 low-contrast wrappers builds 4,000 issue objects on one node
 *  and structured-clones every one of them across postMessage before any
 *  sanitiser sees them. */
const MAX_AXE_ISSUES_PER_NODE = 20

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

/**
 * The nearest ancestor that is actually IN the tree, including the element
 * itself.
 *
 * axe fires on whichever element owns the text, but the snapshot only emits
 * nodes it considers meaningful — so a finding on a plain wrapper was dropped
 * on the floor. `<div>Price <span>10</span></div>` is the commonest text
 * container there is, and a contrast violation on that div reached the agent as
 * nothing at all. Attributing it to the enclosing node is imprecise; losing it
 * is worse. Bounded so a deeply-buried finding cannot climb to the document.
 */
function nearestNode(el: Element, byElement: Map<Element, SnapshotNode>): SnapshotNode | null {
  let cur: Element | null = el
  for (let hops = 0; cur && hops < 6; hops++) {
    const node = byElement.get(cur)
    if (node) return node
    cur = cur.parentElement
  }
  return null
}

/**
 * The elements axe reached a CONTRAST VERDICT on — passed or failed.
 *
 * Deliberately not "the ones it declined". Those are two different questions
 * and only one of them is answerable from `incomplete` alone: an element axe
 * never evaluated appears in no array at all, and "not in `incomplete`" reads
 * it as decided. axe's contrast rule does not match an element it considers
 * invisible on screen — the `left: -9999px` family, a closed `<details>` — so
 * those were covered by nobody with `analysis: true`, while `analysis: false`
 * reported them. Turning analysis on removed a finding, which is the shape of
 * the bug the previous round fixed, one step over.
 *
 * Asking who axe DECIDED about answers it, and fails in the safe direction: an
 * element missing from this set is measured, not skipped.
 */
function decidedContrast(...results: Array<AxeViolation[] | undefined>): Set<Element> {
  const out = new Set<Element>()
  for (const group of results) {
    for (const result of group ?? []) {
      if (result.id !== 'color-contrast') continue
      for (const axeNode of result.nodes ?? []) {
        const el = elementOf(axeNode)
        if (el) out.add(el)
      }
    }
  }
  return out
}

function joinAxe(violations: AxeViolation[], byElement: Map<Element, SnapshotNode>): void {
  for (const violation of violations ?? []) {
    for (const axeNode of violation.nodes ?? []) {
      const el = elementOf(axeNode)
      if (!el) continue
      const node = nearestNode(el, byElement)
      if (!node) continue
      const issue = toIssue(violation, axeNode)
      // Three sibling price wrappers with three different contrast ratios all
      // walk up to the same `<main>`, so deduping on the RULE kept one and
      // silently dropped two real defects. What makes two findings the same
      // finding is the rule AND what it measured — not the rule alone.
      const issues = node.issues ?? []
      if (issues.length >= MAX_AXE_ISSUES_PER_NODE) continue
      // Only when the finding is NOT on this node: an honest same-element
      // finding already has the node's own box and paying for a duplicate of it
      // on every issue is the kind of per-node cost that multiplies.
      if (!byElement.has(el)) issue.at = boxOf(el)
      if (
        issues.some(
          (existing) =>
            existing.rule === issue.rule &&
            existing.measured === issue.measured &&
            existing.needed === issue.needed &&
            sameBox(existing.at, issue.at),
        )
      ) {
        continue
      }
      issues.push(issue)
      node.issues = issues
    }
  }
}

function sameBox(a: Rect | undefined, b: Rect | undefined): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
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
  resetCaptureCaches()

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
  let contrastDecided = new Set<Element>()
  if (analysis) {
    try {
      const context = scope.length > 0 && roots.length > 0 ? roots : document
      const result = await withRunTimeout(analysis.run(context, AXE_RULES))
      violations = result.violations
      // `incomplete` is NOT a verdict, so it is not in here — those elements
      // are exactly the ones measurement has to cover.
      contrastDecided = decidedContrast(result.violations, result.passes)
    } catch {
      analysisError = 'run-failed' satisfies AnalysisFailure
    }
  }

  // Contrast coverage is decided PER NODE, not once for the whole capture.
  //
  // The first rule was `flatContrast = violations === null` — the moment axe ran
  // at all, the measurement pass stood down everywhere. But axe declines to
  // decide contrast on any node whose foreground has alpha, whose text overlaps
  // something, whose content is generated, or whose font is an icon font: it
  // returns those as `incomplete`, which is neither a pass nor a failure. So on
  // the only path production uses (`analysis: true`) those nodes were checked by
  // nobody — and the measurement pass is strictly BETTER there, because it
  // composites alpha itself.
  //
  // The second rule — "measurement covers what axe returned as incomplete" —
  // had the same shape one layer in. It still assumed every element got an
  // answer, and an element axe never EVALUATED gets no answer at all. So the
  // rule is now stated the only way that is exhaustive: axe owns what it
  // reached a verdict on, measurement owns everything else.
  const axeRan = violations !== null
  for (const candidate of ctx.candidates) {
    const flatContrast = !axeRan || !contrastDecided.has(candidate.el)
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
