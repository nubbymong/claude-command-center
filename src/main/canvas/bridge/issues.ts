// Measurement rules — the findings that exist only in the RENDER.
//
// These are the P0 categories that source review structurally cannot reach:
// text clipped by its box, targets too small to hit, elements sitting on top of
// each other, and text that does not survive its background. axe-core covers the
// rest (names, roles, flat-background contrast) and is joined in separately.

import type { AxeIssue, SnapshotNode } from '../../../shared/canvas'
import { composite, contrastRatio, formatRatio, parseColor, requiredContrast, type Rgba } from './color'
import { backdropOf, styleOf } from './measure'

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
function isInactive(el: Element): boolean {
  let node: Element | null = el
  let depth = 0
  while (node && depth < 8) {
    const tag = node.tagName.toLowerCase()
    if (tag === 'option' || tag === 'optgroup') return true
    if ((node as Partial<HTMLInputElement>).disabled === true) return true
    if (node.getAttribute('aria-disabled') === 'true') return true
    if (node.hasAttribute('inert')) return true
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

function contrastIssue(c: Candidate, flatContrast: boolean): AxeIssue | null {
  if (c.srOnly || c.text.length === 0) return null
  if (c.opacity < 0.05) return null
  if (isInactive(c.el)) return null
  const cs = styleOf(c.el)
  if (!cs) return null

  const fg = parseColor(cs.color)
  if (!fg) return null
  const backdrop = backdropOf(c.el)
  // A photographic/asset background is unknowable without sampling the render,
  // and guessing produces exactly the false positives P0 charged us with
  // avoiding. Gradients are different: their stops ARE the backdrop.
  if (backdrop.hasImage && backdrop.gradientStops.length === 0) return null
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
}

export function measurementIssues(c: Candidate, options: MeasurementOptions = { flatContrast: true }): AxeIssue[] {
  const out: AxeIssue[] = []
  const clipped = clippedIssue(c)
  if (clipped) out.push(clipped)
  const target = targetSizeIssue(c)
  if (target) out.push(target)
  const contrast = contrastIssue(c, options.flatContrast)
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

const MAX_OVERLAP_COMPARISONS = 200_000

/** Per-node, not just per-pass. Bounding comparisons alone still let one node
 *  accumulate ~4,000 issue objects on a degenerate page — all of which get
 *  structured-cloned across postMessage before any sanitiser sees them. Matches
 *  the sanitiser's own maxIssuesPerNode, and the pass is worthless past a
 *  handful anyway. */
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
  let comparisons = 0

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]
    const aBottom = a.node.box.y + a.node.box.height
    let reported = 0
    for (let j = i + 1; j < sorted.length; j++) {
      if (reported >= MAX_OVERLAPS_PER_NODE) break
      const b = sorted[j]
      if (b.node.box.y >= aBottom) break
      if (++comparisons > MAX_OVERLAP_COMPARISONS) return
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const area = intersectionArea(a.node.box, b.node.box)
      if (area <= 0) continue
      const smaller = Math.min(a.node.box.width * a.node.box.height, b.node.box.width * b.node.box.height)
      if (smaller <= 0 || area / smaller < OVERLAP_FRACTION) continue
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
  }
}
