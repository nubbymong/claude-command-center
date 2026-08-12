// Measurement rules — the findings that exist only in the RENDER.
//
// These are the P0 categories that source review structurally cannot reach:
// text clipped by its box, targets too small to hit, elements sitting on top of
// each other, and text that does not survive its background. axe-core covers the
// rest (names, roles, flat-background contrast) and is joined in separately.

import type { AxeIssue, SnapshotNode } from '../../../shared/canvas'
import { composite, contrastRatio, formatRatio, parseColor, requiredContrast, type Rgba } from './color'
import { backdropOf, boxOf, styleOf } from './measure'

export interface Candidate {
  el: Element
  node: SnapshotNode
  role: string
  interactive: boolean
  srOnly: boolean
  opacity: number
  /** Text owned directly by this element (empty for containers). */
  text: string
}

/** WCAG 2.2 SC 2.5.8 (AA). */
const MIN_TARGET_PX = 24

/** Ratios inside this band of the threshold are not worth a finding — rounding
 *  in the compositor, not a defect. */
const CONTRAST_EPSILON = 0.05

function round(n: number): number {
  return Math.round(n)
}

function fontWeightOf(cs: CSSStyleDeclaration): number {
  const raw = (cs.fontWeight || '').trim()
  if (raw === 'bold' || raw === 'bolder') return 700
  if (raw === 'normal' || raw === '') return 400
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? n : 400
}

/**
 * KNOWN LIMIT, recorded so the next round does not re-fix it the way the last
 * one did.
 *
 * Content pushed out of view by an `overflow: hidden` ANCESTOR — a carousel
 * slide at x=900 inside a 300px track, an inactive tab panel — still has a real
 * box, so every rule below measures it as painted.
 *
 * The fix looks obvious and is a weapon. An earlier round added exactly that
 * check and it had to be reverted: keyed on an ancestor's box it silenced
 * findings on plainly visible content (`overflow: visible` is the default and
 * says nothing about what is painted), and a negative `window.scrollX` — which
 * is ordinary in RTL — applied it to the entire page. Any rule of the form
 * "this element is not really visible" is a suppression primitive, and a page
 * that can reach it can hide its own defects from review.
 *
 * It is also not clearly a false positive: a slide and a tab panel both BECOME
 * visible, so a contrast defect on one is a defect. What would settle it is a
 * real layout engine in the acceptance run — which is the same gate the
 * ten-seeded-defect run is waiting on, and CI has no browser. Until then this
 * stays as written and stays written down.
 */

/** Text clipped by its own box: real on the page, invisible in the source. */
function clippedIssue(c: Candidate): AxeIssue | null {
  if (c.srOnly) return null
  const cs = styleOf(c.el)
  if (!cs) return null
  const overflow = `${cs.overflow} ${cs.overflowX} ${cs.overflowY}`
  if (!/hidden|clip/.test(overflow)) return null
  // An ellipsis is a designed truncation, not a defect.
  if (cs.textOverflow === 'ellipsis') return null

  const el = c.el as Element & { scrollWidth?: number; clientWidth?: number; scrollHeight?: number; clientHeight?: number }
  const sw = el.scrollWidth ?? 0
  const cw = el.clientWidth ?? 0
  const sh = el.scrollHeight ?? 0
  const ch = el.clientHeight ?? 0

  if (cw > 0 && sw - cw > 1) {
    return {
      rule: 'clipped-content',
      severity: 'serious',
      measured: `${round(sw)}px content in ${round(cw)}px box`,
      needed: `${round(sw)}px`,
    }
  }
  if (ch > 0 && sh - ch > 1) {
    return {
      rule: 'clipped-content',
      severity: 'serious',
      measured: `${round(sh)}px content in ${round(ch)}px box`,
      needed: `${round(sh)}px`,
    }
  }
  return null
}

/** Hit targets below the WCAG 2.2 minimum. */
function targetSizeIssue(c: Candidate): AxeIssue | null {
  if (!c.interactive || c.srOnly) return null
  const cs = styleOf(c.el)
  // Inline targets in a run of text are exempt (SC 2.5.8 inline exception).
  if (cs && cs.display === 'inline') return null
  const { width, height } = c.node.box
  const min = Math.min(width, height)
  if (min <= 0 || min >= MIN_TARGET_PX) return null
  return {
    rule: 'target-size',
    severity: 'moderate',
    measured: `${round(width)}x${round(height)}px`,
    needed: `${MIN_TARGET_PX}x${MIN_TARGET_PX}px`,
  }
}

/**
 * Contrast, including the case axe declines to judge.
 *
 * axe returns `color-contrast: incomplete` whenever a background-image is
 * involved, so gradient surfaces — the normal way modern UI is painted — are
 * never failed by it. Here the gradient's own stops are the backdrop and the
 * worst stop decides, which is the honest reading of "can this text be read
 * anywhere along it".
 */
/**
 * Components WCAG 1.4.3 exempts from contrast: the inactive ones. Greyed out
 * IS the design, and reporting it tells a reviewer to fix the thing that works.
 *
 * This has to live here rather than be left to axe. axe drops disabled
 * controls, `<option>`s and the label of a disabled control from its contrast
 * rule BEFORE it consults layout, so they appear in none of its result arrays
 * — and a measurement pass that covers everything axe did not FAIL covers
 * exactly them. Without this, every disabled control on every page.
 */
/**
 * Elements on which `aria-disabled` and `disabled` MEAN something.
 *
 * `aria-disabled` on a plain `<div>` is not a disabled control — ARIA only
 * defines the state for widgets — but this function honoured it on any ancestor
 * for eight levels, so one attribute on one generic wrapper deleted contrast
 * review for everything inside it, and the wrapper was not even emitted so
 * nothing in the snapshot hinted at why. Two keystrokes, no JavaScript,
 * subtree-wide, with no `issuesDropped` and no note: the cheapest suppression
 * primitive found in this pass.
 *
 * It is also a large accidental false-negative source. Component libraries
 * routinely put `aria-disabled` on a wrapper — a disabled tab strip, a menu, a
 * card — and every one of those silently removed contrast review from all of
 * its contents.
 */
const DISABLEABLE = new Set([
  'button', 'input', 'select', 'textarea', 'option', 'optgroup', 'fieldset', 'a', 'summary', 'label',
])

const DISABLEABLE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'slider', 'spinbutton', 'textbox', 'searchbox', 'combobox', 'listbox', 'treeitem', 'gridcell',
])

function canBeDisabled(el: Element, tag: string): boolean {
  if (DISABLEABLE.has(tag)) return true
  const role = el.getAttribute('role')
  return role != null && DISABLEABLE_ROLES.has(role.trim().split(/\s+/)[0].toLowerCase())
}

function isInactive(el: Element): boolean {
  let node: Element | null = el
  let depth = 0
  while (node && depth < 8) {
    const tag = node.tagName.toLowerCase()
    if (tag === 'option' || tag === 'optgroup') return true
    // `inert` is a real HTML attribute with subtree semantics — the browser
    // removes the subtree from interaction and from the a11y tree — so it is
    // honoured on any ancestor. `disabled`/`aria-disabled` are widget state and
    // are honoured only where a widget could carry them.
    if (node.hasAttribute('inert')) return true
    if (canBeDisabled(node, tag)) {
      if ((node as Partial<HTMLInputElement>).disabled === true) return true
      if (node.getAttribute('aria-disabled') === 'true') return true
    }
    // A <label> is exempt when the control it labels is — the greying is the
    // control's, and the label is painted to match it.
    if (tag === 'label') {
      const target = node.getAttribute('for')
      const control = target
        ? node.ownerDocument?.getElementById(target)
        : node.querySelector('input, select, textarea, button')
      if (control && ((control as Partial<HTMLInputElement>).disabled === true || control.getAttribute('aria-disabled') === 'true')) {
        return true
      }
    }
    node = node.parentElement
    depth++
  }
  return false
}

/**
 * The one honest output when the backdrop is not knowable: name the gap. It
 * cannot be a false positive, because it does not claim a defect.
 *
 * Reported once per DECLARING element, not once per text node. `reported` is the
 * capture's memo of which declarations have already been named: one
 * `background-image` on a hero put this on all 300 paragraphs beneath it, and on
 * a dense page that pushed a genuine `critical button-name` off the wire — a
 * coverage note that costs real findings is a worse trade than the silence it
 * replaced.
 */
function notAssessed(c: Candidate, why: string, source: Element | null, reported: Set<Element> | undefined): AxeIssue | null {
  const declaring = source ?? c.el
  if (reported) {
    if (reported.has(declaring)) return null
    reported.add(declaring)
  }
  const issue: AxeIssue = {
    rule: 'contrast-not-assessed',
    severity: 'minor',
    measured: why,
    needed: 'check this by eye',
  }
  // Where the cause is, when that is not this node — the same convention the
  // axe join uses. Without it the agent is told a paragraph cannot be assessed
  // and has no way to find the ancestor that made it so.
  if (declaring !== c.el) issue.at = boxOf(declaring)
  return issue
}

function contrastIssue(c: Candidate, flatContrast: boolean, reported?: Set<Element>): AxeIssue | null {
  if (c.srOnly || c.text.length === 0) return null
  if (c.opacity < 0.05) return null
  if (isInactive(c.el)) return null
  const cs = styleOf(c.el)
  if (!cs) return null

  const fg = parseColor(cs.color)
  // A foreground that does not parse used to `return null` — silently, and into
  // the same hole every other silent decline here fell into: axe routes nothing
  // to `violations` for it either, so the text was checked by nobody while the
  // capture note claimed contrast coverage.
  if (!fg) return notAssessed(c, 'text colour could not be read', c.el, reported)
  const backdrop = backdropOf(c.el)
  // A photographic/asset background is unknowable without sampling the render,
  // and guessing produces exactly the false positives P0 charged us with
  // avoiding. Gradients are different: their stops ARE the backdrop.
  //
  // But SAY SO, rather than returning nothing. axe routes the same element to
  // `incomplete` — never to `violations` — so it is not in `contrastFailed`,
  // measurement is asked to cover it, and measurement then declines: contrast
  // is checked by NOBODY. One `background-image: url(…)` on a wrapper, even one
  // that 404s, silenced every text node beneath it, with no marker anywhere and
  // a capture note actively telling the agent "measurements and contrast still
  // apply".
  if (backdrop.hasImage && backdrop.gradientStops.length === 0) {
    return notAssessed(c, 'text sits on an image', backdrop.source, reported)
  }
  // A backdrop layer that did not PARSE is the same gap wearing a disguise, and
  // the more dangerous one: an unreadable layer is skipped, a skipped layer is
  // indistinguishable from an absent one, and the composite then falls all the
  // way through to page white. Tailwind v4 writes its whole palette in
  // `oklch()`, so before the parser understood CSS Color 4 this was not an edge
  // case — it was every Tailwind page: near-black text on a near-black hero,
  // measured against imaginary white, reported as 21:1 and passing.
  if (backdrop.unreadable) {
    return notAssessed(c, 'backdrop colour could not be read', backdrop.source, reported)
  }
  const text: Rgba = fg.a < 1 ? composite(fg, backdrop.color) : fg
  const required = requiredContrast(parseFloat(cs.fontSize) || 16, fontWeightOf(cs))

  let ratio: number
  let rule: string
  if (backdrop.gradientStops.length > 0) {
    rule = 'color-contrast-gradient'
    ratio = Infinity
    for (const stop of backdrop.gradientStops) {
      const solid = stop.a < 1 ? composite(stop, backdrop.color) : stop
      ratio = Math.min(ratio, contrastRatio(text, solid))
    }
  } else {
    if (!flatContrast) return null
    rule = 'color-contrast'
    ratio = contrastRatio(text, backdrop.color)
  }

  if (!Number.isFinite(ratio) || ratio + CONTRAST_EPSILON >= required) return null
  return {
    rule,
    severity: 'serious',
    measured: formatRatio(ratio),
    needed: formatRatio(required),
  }
}

export interface MeasurementOptions {
  /** Claim plain (non-gradient) contrast. False when axe-core is running, since
   *  axe is authoritative there and double-reporting helps nobody. */
  flatContrast: boolean
  /** The capture's memo of which declarations have already produced a
   *  `contrast-not-assessed`. Shared across every candidate in one capture; a
   *  caller that omits it gets one finding per node, which is what the round-6
   *  noise regression was. */
  notAssessedReported?: Set<Element>
}

export function measurementIssues(c: Candidate, options: MeasurementOptions = { flatContrast: true }): AxeIssue[] {
  const out: AxeIssue[] = []
  const clipped = clippedIssue(c)
  if (clipped) out.push(clipped)
  const target = targetSizeIssue(c)
  if (target) out.push(target)
  const contrast = contrastIssue(c, options.flatContrast, options.notAssessedReported)
  if (contrast) out.push(contrast)
  return out
}

function intersectionArea(a: SnapshotNode['box'], b: SnapshotNode['box']): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** Overlap only counts when it is this much of the smaller box — a few pixels of
 *  kerning bleed is not a finding. */
const OVERLAP_FRACTION = 0.25

/**
 * How many candidates ONE node compares itself against.
 *
 * Per node, replacing a single budget for the whole pass — and that is a fix,
 * not a tuning. One counter meant the first node in the sweep could spend all
 * of it: measured, 634 benign boxes sharing a y-band exhausted the budget and a
 * genuine overlap further down the page was never looked for, with nothing said
 * anywhere in the output. A per-node bound cannot starve a later node, it needs
 * no whole-pass abort, and it bounds the total just as well — 4,000 nodes x 64
 * is the same order as the 200,000 it replaces.
 */
const MAX_OVERLAP_COMPARISONS_PER_NODE = 64

/**
 * How many overlaps one node REPORTS. Bounding comparisons alone still let one
 * node accumulate thousands of issue objects on a degenerate page, all of which
 * get structured-cloned across postMessage before any sanitiser sees them.
 *
 * Twenty, not eight. Eight was a false economy: the argument for it was that
 * overlap is the least severe rule here and its slots are better spent on
 * something that matters more — but the severity trim already does exactly
 * that, and it does it with the whole node in view. All eight bought was up to
 * twelve real findings discarded on a node whose findings are ALL overlaps,
 * where there is nothing more severe to rescue.
 */
const MAX_OVERLAPS_PER_NODE = 20

/**
 * Content boxes sitting on top of each other. Restricted to IN-FLOW content
 * (static/relative position) because absolutely positioned and fixed elements
 * overlap by design — that restriction is what keeps this rule from crying wolf
 * on every dropdown, tooltip and sticky header.
 *
 * Mutates each node's `issues`, so it runs once over the whole walked set.
 */
export function addOverlapIssues(candidates: Candidate[]): void {
  const eligible = candidates.filter((c) => {
    if (c.srOnly || c.opacity < 0.05) return false
    if (c.node.box.width <= 0 || c.node.box.height <= 0) return false
    if (!c.interactive && c.text.length === 0) return false
    const cs = styleOf(c.el)
    if (!cs) return false
    return cs.position === 'static' || cs.position === 'relative' || cs.position === ''
  })

  // Sweep by vertical position: only boxes whose y-ranges meet can intersect.
  const sorted = eligible.slice().sort((a, b) => a.node.box.y - b.node.box.y)

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]
    const aBottom = a.node.box.y + a.node.box.height
    let reported = 0
    let dropped = 0
    let comparisons = 0
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]
      // The sweep's own bound: nothing below this node's bottom edge can meet it.
      if (b.node.box.y >= aBottom) break
      // The work bound. Past here we stop LOOKING, so what lies beyond is
      // unknown — and unknown is never claimed. See the drop count below.
      if (++comparisons > MAX_OVERLAP_COMPARISONS_PER_NODE) break
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const area = intersectionArea(a.node.box, b.node.box)
      if (area <= 0) continue
      const smaller = Math.min(a.node.box.width * a.node.box.height, b.node.box.width * b.node.box.height)
      if (smaller <= 0 || area / smaller < OVERLAP_FRACTION) continue
      // A real overlap. Carry the first few and COUNT the rest exactly.
      //
      // The count used to be taken at the top of the loop the moment the report
      // cap was reached — before the y-band break, before the containment and
      // area tests — so a node with exactly twenty partners and one unrelated
      // box below it was charged a drop that never happened. That is worse than
      // a wrong number: the trust boundary reserves a wire slot the instant a
      // drop is declared, so a phantom drop DESTROYS a genuine finding to make
      // room for a line saying a finding was lost.
      if (reported >= MAX_OVERLAPS_PER_NODE) {
        dropped++
        continue
      }
      const issue: AxeIssue = {
        rule: 'overlap',
        severity: 'moderate',
        measured: `${round(area)}px² with ${b.node.ref}`,
        needed: 'no overlap',
      }
      a.node.issues = a.node.issues ?? []
      a.node.issues.push(issue)
      reported++
    }
    if (dropped > 0) a.node.issuesDropped = (a.node.issuesDropped ?? 0) + dropped
  }
}
