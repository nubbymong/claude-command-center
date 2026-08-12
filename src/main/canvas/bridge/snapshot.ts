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
import { hidesItsContent, isInteractive, isMeaningful, isSkipped, nameOf, parentOf, roleOf, squash } from './semantics'

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
  /** Something paints here and offers no tree to read — a closed shadow root
   *  being the case that produces it. See the walk. */
  hiddenContent: boolean
}

/** Failure CODES, never messages: analysisError is surfaced to the agent as a
 *  capture note outside the untrusted envelope, so its vocabulary is closed
 *  (canvas-snapshot-sanitize.ts enforces the same set on arrival). */
type AnalysisFailure = 'load-failed' | 'run-failed'

function walk(el: Element, ctx: WalkContext, depth: number): SnapshotNode | SnapshotNode[] | null {
  // Before the depth test, so a <script> or <style> at the boundary is refused
  // for what it is rather than for where it is. The guard below reaches the
  // same answer on its own — no skipped tag can have element children in a
  // parsed document (`<template>` keeps its content in a DocumentFragment,
  // `<noscript>` keeps its as text), so this ordering is belt and braces, not
  // load-bearing. Recorded because a mutation that swaps it survives, and a
  // surviving mutant that is genuinely equivalent should be labelled rather
  // than have a test contorted around it.
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
    // true: there is CONTENT below here that was not walked.
    //
    // "Certainly" is why an empty, non-meaningful leaf does not set it. A chain
    // of bare wrappers bottoming out in nothing lost nothing, and a note that
    // fires on a page which lost nothing costs the agent a second capture — the
    // very cost this flag was split out to avoid.
    if (el.children.length > 0 || el.shadowRoot || isMeaningful(el)) ctx.depthLimited = true
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

  // An OPEN shadow root's own children, after the light ones.
  //
  // Without this a web component's entire contents were painted, interactive
  // and completely unreviewed — with `truncated`, `depthLimited` and
  // `issuesDropped` all unset, so the tool reported success on a bare document
  // root. That is ordinary markup for Lit, Stencil, Shoelace and Ionic, and one
  // attribute (`<template shadowrootmode>`) in agent-authored HTML.
  //
  // No element is emitted twice by walking both: a slotted light child is
  // rendered inside the shadow tree but stays a child of its LIGHT parent, and
  // is reachable from the shadow side only through `assignedElements()`, which
  // nothing here calls. The nesting a slot implies is therefore not reproduced —
  // the tree says where each element LIVES, not where it lands — which is the
  // same trade the wrapper-splicing above already makes.
  const shadow = el.shadowRoot
  if (shadow) {
    for (let i = 0; i < shadow.children.length; i++) {
      if (ctx.nextRef > MAX_NODES) {
        ctx.truncated = true
        break
      }
      const walked = walk(shadow.children[i], ctx, depth + 1)
      if (walked === null) continue
      if (Array.isArray(walked)) children = children.concat(walked)
      else children.push(walked)
    }
  } else if (children.length === 0 && hidesItsContent(el) && isVisible(el)) {
    // A CLOSED root, or something else that paints without exposing a tree. Not
    // knowable, so not guessed at — but it is knowable that a box is painted
    // here and the walk found nothing in it, and saying so is the difference
    // between a partial review and a review that reports success.
    ctx.hiddenContent = true
  }

  // A non-semantic wrapper contributes nothing but its children, which are
  // spliced up a level to keep the tree (and its token cost) shallow.
  if (!node) return children
  node.children = children
  return node
}

/** How many elements the shadow-piercing scope search will look at. Only spent
 *  when the flat query left an id unmatched, and a page that large has already
 *  paid more than this walking itself. */
const MAX_SCOPE_SEARCH = 20_000

/**
 * Find scope roots inside open shadow trees, which `querySelectorAll` cannot
 * reach.
 *
 * Runs only as a FALLBACK. The flat query is one call into the engine's
 * selector index; this is a full tree walk in script, and paying for it on
 * every capture to serve the minority of pages that use custom elements is the
 * wrong default. It also stops as soon as every wanted id is accounted for.
 */
function searchShadowScope(root: ParentNode, wanted: Set<string>, found: Map<string, Element>, budget: { left: number }): void {
  const children = root.children
  for (let i = 0; i < children.length && budget.left > 0 && found.size < wanted.size; i++) {
    const el = children[i]
    budget.left--
    const id = el.getAttribute('data-ux-id')
    if (id && wanted.has(id) && !found.has(id)) found.set(id, el)
    if (el.shadowRoot) searchShadowScope(el.shadowRoot, wanted, found, budget)
    searchShadowScope(el, wanted, found, budget)
  }
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
  // An id the flat query missed may still be inside an open shadow tree, where a
  // selector cannot follow. Reporting it as `unmatchedScope` sent the agent to
  // re-scope against an anchor that IS on the page.
  if (found.size < wanted.size && document.body) {
    searchShadowScope(document.body, wanted, found, { left: MAX_SCOPE_SEARCH })
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

/**
 * The element an axe result is about.
 *
 * `elementRef: true` means `node.element` is normally there and this is one
 * property read. The selector paths below are the fallback, and the second of
 * them is not exotic: for anything inside a shadow tree axe reports `target` as
 * an ARRAY of selectors — `[['my-card', '#go']]` — one per shadow boundary to
 * cross. That shape hit `typeof selector !== 'string'` and returned null, so a
 * finding on a web component's own button was silently discarded.
 */
function elementOf(node: AxeNodeResult): Element | null {
  if (node.element) return node.element
  const target = node.target?.[0]
  if (typeof target === 'string') {
    try {
      return document.querySelector(target)
    } catch {
      return null
    }
  }
  if (!Array.isArray(target)) return null
  // Each hop resolves inside the previous hop's shadow root.
  let scope: ParentNode | null = document
  let el: Element | null = null
  for (const step of target) {
    if (typeof step !== 'string' || !scope) return null
    try {
      el = scope.querySelector(step)
    } catch {
      return null
    }
    if (!el) return null
    scope = el.shadowRoot
  }
  return el
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
    // Crosses out of a shadow tree, where `parentElement` is null: a finding on
    // a web component's inner button otherwise had no ancestor at all.
    cur = parentOf(cur)
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

function joinAxe(violations: AxeViolation[], byElement: Map<Element, SnapshotNode>, root: SnapshotNode): void {
  // What THIS pass has put on each node, and only this pass. Sharing a counter
  // with the measurement and overlap passes let the cheapest finding starve the
  // most severe one; see MAX_AXE_ISSUES_PER_NODE.
  const axeHeld = new Map<SnapshotNode, AxeIssue[]>()
  for (const violation of violations ?? []) {
    for (const axeNode of violation.nodes ?? []) {
      const el = elementOf(axeNode)
      if (!el) {
        // A finding axe HAS and this walk cannot place. Counted on the root
        // rather than dropped: a number the agent can see is the difference
        // between a partial answer and a wrong one, and every other producer in
        // this pipeline already counts what it loses.
        root.issuesDropped = (root.issuesDropped ?? 0) + 1
        continue
      }
      const node = nearestNode(el, byElement) ?? root
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
function trimIssues(nodes: Iterable<SnapshotNode>): void {
  for (const node of nodes) {
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
    hiddenContent: false,
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
  // One memo for the whole capture: `contrast-not-assessed` names a DECLARATION
  // (an ancestor's image, a colour that would not parse), and a declaration
  // covers every text node under it. Per-node it put the same note on 300
  // paragraphs and pushed genuine findings off the wire.
  const notAssessedReported = new Set<Element>()
  for (const candidate of ctx.candidates) {
    const flatContrast = !axeRan || !contrastFailed.has(candidate.el)
    const issues = measurementIssues(candidate, { flatContrast, notAssessedReported })
    if (issues.length > 0) candidate.node.issues = (candidate.node.issues ?? []).concat(issues)
  }
  addOverlapIssues(ctx.candidates)

  // Joined after the measurement pass so the dedupe keeps the measured finding
  // when both fire on one node.
  if (violations) joinAxe(violations, ctx.byElement, root)

  // Last, once every pass has had its say: only here is the per-node total
  // known, and only here can "which twenty" be answered by severity rather than
  // by which pass happened to run first.
  //
  // The ROOT is in this list as well as the candidates. It is not a candidate —
  // nothing measures it — but the axe join now uses it as the home for a
  // finding whose element it cannot place, so it can hold issues like any other
  // node and must be bounded like any other node.
  //
  // Today that bound is already reached one step earlier, because the join's own
  // per-node cap happens to EQUAL MAX_ISSUES_PER_NODE — so a mutation removing
  // `root` from this list survives the suite, and it is left in deliberately
  // rather than tested around. The two are separate numbers that agree by
  // coincidence, and this is the one the WIRE enforces: raise the join's cap
  // without this line and a node reaches the sanitiser over the limit, to be
  // trimmed there by a pass that cannot see severity the way this one can.
  trimIssues([root, ...ctx.candidates.map((c) => c.node)])

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
  if (ctx.hiddenContent) out.hiddenContent = true
  if (analysisError) out.analysisError = analysisError
  return out
}
