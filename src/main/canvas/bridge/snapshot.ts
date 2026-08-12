// SemanticSnapshot capture (spec §4).
//
// One walk of the rendered document produces the tree, the measurement findings
// and the element↔node index that axe results are joined onto. Scoping is by
// `data-ux-id` — the anchor the authoring contract asks for — and is what keeps
// a snapshot affordable: styles ride only on scoped nodes (§4.1).

import type { AxeIssue, CanvasSnapshotOptions, CanvasSnapshotResult, Rect, SnapshotNode } from '../../../shared/canvas'
import { MAX_ISSUES_PER_NODE, keepMostSevere, severityRank } from '../../../shared/canvas'
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
  depthLimited: boolean
}

/** Failure CODES, never messages: analysisError is surfaced to the agent as a
 *  capture note outside the untrusted envelope, so its vocabulary is closed
 *  (canvas-snapshot-sanitize.ts enforces the same set on arrival). */
type AnalysisFailure = 'load-failed' | 'run-failed'

function walk(el: Element, ctx: WalkContext, depth: number): SnapshotNode | SnapshotNode[] | null {
  // BEFORE the depth test: a <script> or <style> contributes nothing at any
  // depth, so refusing one is not a truncation and must not be reported as one.
  if (isSkipped(el)) return null
  if (depth > MAX_DEPTH) {
    // Reported, unlike the node cap beside it, which always was — the depth cap
    // drops a whole SUBTREE, and it drops it here inside the page, so nothing
    // downstream can know it happened and the agent read a tree that simply
    // stops as a page that ends there.
    //
    // Its own flag, NOT `truncated`. `truncated` means "nodes were dropped" and
    // drives a note blaming the node limit; a deeply-nested page trips this one
    // without necessarily losing a single node, and 66 levels is routine once
    // providers, portals and layout wrappers stack up. Claiming a limit that
    // did not fire costs the agent a whole second capture — which is the exact
    // cost this series cites for NOT stamping `truncated` on the JSON
    // pretty-to-compact fallback. `depthLimited` claims only what is certainly
    // true: there is DOM below here that was not walked.
    ctx.depthLimited = true
    return null
  }

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

/**
 * How many AXE findings one node may absorb — counted separately from the
 * measurement and overlap passes, which is the whole point of it.
 *
 * It used to test `node.issues.length`, and `measurementIssues` and
 * `addOverlapIssues` both run first: twenty-one overlapping elements therefore
 * spent the entire per-node budget before the join was reached, and a
 * `critical` missing button name was dropped on the floor to make room for
 * twenty `moderate` overlaps. A shared budget that the cheapest finding is
 * allowed to exhaust is not a budget, it is a race.
 *
 * The cap itself still has to exist: attributing findings to an ancestor
 * CONCENTRATES them, so a page of 4,000 low-contrast wrappers would otherwise
 * build 4,000 issue objects on one node and structured-clone every one of them
 * across postMessage before any sanitiser sees them.
 */
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
 * The elements axe FAILED for contrast — and only those.
 *
 * The question here went through three versions and the third is the one that
 * is answerable. "Did axe run at all?" stood the measurement pass down
 * globally, so every check axe declined was covered by nobody. "Did axe return
 * this as `incomplete`?" assumed every element gets an answer, and one axe
 * never EVALUATED gets none — its contrast rule does not match an element it
 * considers invisible on screen, so those were covered by nobody either.
 * "Which elements did axe reach a verdict on?" was exact, but answering it
 * required axe's `passes` array and that cost far more than the answer was
 * worth (see analysis.ts).
 *
 * So: axe owns what it FAILED, measurement owns everything else. That needs no
 * `passes`, covers declined and never-evaluated alike, and its failure
 * direction is more coverage rather than less. What it gives up is that a node
 * axe explicitly passed gets measured again — which costs a little work and is
 * only visible at all if the two disagree.
 */
function failedContrast(violations: AxeViolation[] | undefined): Set<Element> {
  const out = new Set<Element>()
  for (const result of violations ?? []) {
    if (result.id !== 'color-contrast') continue
    for (const axeNode of result.nodes ?? []) {
      const el = elementOf(axeNode)
      if (el) out.add(el)
    }
  }
  return out
}

/** Three sibling price wrappers with three different contrast ratios all walk up
 *  to the same `<main>`, so deduping on the RULE kept one and silently dropped
 *  two real defects. What makes two findings the same finding is the rule, what
 *  it measured, WHAT IT COST, and where it is — omitting the severity collapsed
 *  a `critical` into an identical `moderate` and told the agent the lesser. */
function sameIssue(a: AxeIssue, b: AxeIssue): boolean {
  return (
    a.rule === b.rule &&
    a.severity === b.severity &&
    a.measured === b.measured &&
    a.needed === b.needed &&
    sameBox(a.at, b.at)
  )
}

function joinAxe(violations: AxeViolation[], byElement: Map<Element, SnapshotNode>): void {
  // What THIS pass has put on each node, and only this pass. Sharing a counter
  // with the measurement and overlap passes let the cheapest finding starve the
  // most severe one; see MAX_AXE_ISSUES_PER_NODE.
  const axeHeld = new Map<SnapshotNode, AxeIssue[]>()
  for (const violation of violations ?? []) {
    for (const axeNode of violation.nodes ?? []) {
      const el = elementOf(axeNode)
      if (!el) continue
      const node = nearestNode(el, byElement)
      if (!node) continue
      const issue = toIssue(violation, axeNode)
      // Only when the finding is NOT on this node: an honest same-element
      // finding already has the node's own box and paying for a duplicate of it
      // on every issue is the kind of per-node cost that multiplies.
      if (!byElement.has(el)) issue.at = boxOf(el)
      const issues = node.issues ?? []
      // A duplicate is not a loss, so it is not counted as one.
      if (issues.some((existing) => sameIssue(existing, issue))) continue

      const held = axeHeld.get(node) ?? []
      if (held.length >= MAX_AXE_ISSUES_PER_NODE) {
        node.issuesDropped = (node.issuesDropped ?? 0) + 1
        // The cap is a memory bound, not a claim that the first twenty findings
        // matter most. axe emits in rule order, so a `critical` missing button
        // name routinely arrives behind twenty `moderate`s — and dropping it
        // for arriving late is the same defect as dropping it for arriving
        // after the overlap pass. Trading the weakest one out keeps the bound
        // exact and the choice honest.
        let weakest = 0
        for (let k = 1; k < held.length; k++) {
          if (severityRank(held[k].severity) < severityRank(held[weakest].severity)) weakest = k
        }
        if (severityRank(issue.severity) <= severityRank(held[weakest].severity)) continue
        const victim = held[weakest]
        held.splice(weakest, 1)
        const at = issues.indexOf(victim)
        if (at >= 0) issues.splice(at, 1)
      }
      issues.push(issue)
      held.push(issue)
      node.issues = issues
      axeHeld.set(node, held)
    }
  }
}

/**
 * Cut each node down to what the wire allows, keeping the findings that matter.
 *
 * Three passes contribute to one node and none of them knows what the others
 * found, so the total is only bounded here. Taking the first `MAX_ISSUES_PER_NODE`
 * in the order the passes happened to run is what a slice does, and the order
 * has nothing to do with importance: a realistic 24-card grid reported twenty
 * genuine contrast defects and dropped four with nothing said.
 */
function trimIssues(candidates: Candidate[]): void {
  for (const candidate of candidates) {
    const node = candidate.node
    const issues = node.issues
    if (!issues) continue
    const keep = keepMostSevere(issues.length, (i) => severityRank(issues[i].severity), MAX_ISSUES_PER_NODE)
    if (!keep) continue
    node.issues = issues.filter((_, i) => keep.has(i))
    node.issuesDropped = (node.issuesDropped ?? 0) + (issues.length - node.issues.length)
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
  resetStyleCache()

  const { roots, unmatched } = resolveScope(scope)
  const ctx: WalkContext = {
    includeStyles: scope.length > 0,
    candidates: [],
    byElement: new Map(),
    nextRef: 1,
    truncated: false,
    depthLimited: false,
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
  let contrastFailed = new Set<Element>()
  if (analysis) {
    try {
      const context = scope.length > 0 && roots.length > 0 ? roots : document
      const result = await withRunTimeout(analysis.run(context, AXE_RULES))
      const failed = failedContrast(result.violations)
      // Assigned only once the set is built, so a throw in between cannot leave
      // "axe ran" true beside an empty set — which would double-cover instead
      // of standing measurement down.
      violations = result.violations
      contrastFailed = failed
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
  // answer, and an element axe never EVALUATED gets no answer at all.
  //
  // The rule now names the only set that can be read off axe's output without
  // asking it for more than it is cheap to give: axe owns what it FAILED,
  // measurement owns everything else. Declined and never-looked-at are both on
  // the measurement side, which is where the last two bugs said they belonged.
  const axeRan = violations !== null
  for (const candidate of ctx.candidates) {
    const flatContrast = !axeRan || !contrastFailed.has(candidate.el)
    const issues = measurementIssues(candidate, { flatContrast })
    if (issues.length > 0) candidate.node.issues = (candidate.node.issues ?? []).concat(issues)
  }
  addOverlapIssues(ctx.candidates)

  // Joined after the measurement pass so the dedupe keeps the measured finding
  // when both fire on one node.
  if (violations) joinAxe(violations, ctx.byElement)

  // Last, once every pass has had its say: only here is the per-node total
  // known, and only here can "which twenty" be answered by severity rather than
  // by which pass happened to run first.
  trimIssues(ctx.candidates)

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
  if (ctx.depthLimited) out.depthLimited = true
  if (analysisError) out.analysisError = analysisError
  return out
}
