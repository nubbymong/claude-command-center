// The measurement pass: what the rendered page actually looks like, as opposed
// to what its source says (spec §10 P2, and the whole point of the P0 gate).
//
// Everything here reads layout and computed style. Nothing mutates the page —
// the bridge is read-only from the content side (D8).

import type { Rect, SnapshotNode } from '../../../shared/canvas'
import { composite, parseColor, readBackgroundImage, type Rgba } from './color'
import { holdsTypedText, parentOf } from './semantics'

export type NodeState = NonNullable<SnapshotNode['state']>

/**
 * Ceiling on the reported length of a field's contents.
 *
 * The length is a NUMBER, so it cannot carry page text — but it is still
 * page-chosen, and an unbounded one is an unbounded token on the wire. A
 * million characters in one field is already far past anything a review acts
 * on; the cap says "at least this much" and costs seven characters.
 */
const VALUE_LENGTH_MAX = 1_000_000

/** Curated computed styles (spec §4: font-*, colour, background, padding,
 *  margin, overflow). They are the dominant token cost, so they ride only on
 *  scoped nodes — and even then defaults are dropped. */
const STYLE_DEFAULTS: Record<string, string[]> = {
  // '0' and '0px' are the same nothing; engines disagree on the spelling.
  margin: ['0px', '0'],
  padding: ['0px', '0'],
  overflow: ['visible'],
  'line-height': ['normal'],
  'font-weight': ['400', 'normal'],
  display: ['block'],
}

export function boxOf(el: Element): Rect {
  const rect = el.getBoundingClientRect()
  return {
    x: rect.left + window.scrollX,
    y: rect.top + window.scrollY,
    width: rect.width,
    height: rect.height,
  }
}

export function isVisible(el: Element): boolean {
  if (!el.getClientRects || el.getClientRects().length === 0) return false
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  // `visibility: hidden` keeps its box and its client rects — it reserves space
  // — so geometry alone says "visible" for content that is never painted. Every
  // measurement finding on such a node (contrast, target size, clipping,
  // overlap) is then a false positive, which is the exact class the sr-only work
  // exists to prevent. `display: none` needs no check: it has no rects at all.
  //
  // This DROPS the node, where sr-only and `opacity` merely mark it, and the
  // asymmetry is deliberate rather than an oversight: `visibility: hidden` also
  // removes the subtree from the ACCESSIBILITY tree, so no reader of any kind
  // perceives it. Screen-reader-only text and `opacity: 0` content stay in that
  // tree and are announced, which is exactly why they have to be reported and
  // marked instead of hidden.
  //
  // Deliberately NOT extended to `aria-hidden`: that content IS painted, so its
  // findings are real. Hiding it from the tree would lose them.
  const cs = styleOf(el)
  if (cs && (cs.visibility === 'hidden' || cs.visibility === 'collapse')) return false
  return true
}

/**
 * Per-capture memo for computed styles.
 *
 * Every node walks its ancestors up to three times (effective opacity, sr-only,
 * backdrop) and the overlap pass reads styles again — measured at ~137
 * getComputedStyle calls per emitted node, half a million for one capture of a
 * deep page. getComputedStyle returns a LIVE object, so caching it within a
 * single synchronous capture is safe; `resetStyleCache()` runs at the start of
 * each one so a later capture never reads stale layout.
 */
let styleCache: WeakMap<Element, CSSStyleDeclaration> | null = null

export function resetStyleCache(): void {
  styleCache = new WeakMap()
}

export function styleOf(el: Element): CSSStyleDeclaration | null {
  const cache = styleCache
  if (cache) {
    const hit = cache.get(el)
    if (hit) return hit
  }
  try {
    const cs = window.getComputedStyle(el)
    if (cache && cs) cache.set(el, cs)
    return cs
  } catch {
    return null
  }
}

/** Opacity accumulated through ancestors: 'in the DOM but faded to nothing' is
 *  invisible in source and invisible in a bare a11y tree. */
export function effectiveOpacity(el: Element): number {
  let value = 1
  let node: Element | null = el
  let depth = 0
  while (node && depth < 64) {
    const cs = styleOf(node)
    if (cs) {
      const own = parseFloat(cs.opacity)
      if (Number.isFinite(own)) value *= own
    }
    node = node.parentElement
    depth++
  }
  return Math.max(0, Math.min(1, value))
}

/**
 * Content an ancestor's `overflow: hidden` cannot reach.
 *
 * An ancestor only hides what it CONTAINS. A `position: fixed` element is
 * contained by the viewport, not by its parent, so it paints at full size
 * wherever it likes while a 1x1 wrapper above it says "screen-reader only" —
 * two CSS properties, no JavaScript, and every measurement rule on the subtree
 * is deleted. Top-layer content (an open popover, a modal `<dialog>`) is
 * painted outside the box tree entirely and escapes for the same reason.
 *
 * NOT a box comparison. Comparing the painted boxes was the first attempt at
 * this and it broke the canonical pattern outright: `overflow: hidden` clips
 * PAINT, not the border box, so the screen-reader-only link inside the standard
 * 1x1 wrapper still measures its full natural 133x17 and failed any containment
 * test. Checked in a real browser — the link is not painted, and its box was
 * never the question. Reporting it as a 1px target with unreadable contrast is
 * exactly the P0 run-2 false positive this whole function exists to prevent.
 *
 * Only `overflow` has this hole. Legacy `clip` does clip a fixed descendant,
 * and `clip-path` establishes a containing block so its descendants cannot be
 * fixed relative to anything else — both verified in a browser rather than
 * reasoned from the spec.
 */
function escapesOverflowClip(el: Element): boolean {
  if (styleOf(el)?.position === 'fixed') return true
  // Top layer, if this engine knows the selectors. `:modal` is not universal
  // and jsdom throws on it, so an unknown selector means "not in the top layer"
  // rather than an exception out of a measurement pass.
  for (const selector of [':popover-open', ':modal']) {
    try {
      if (el.matches(selector)) return true
    } catch {
      /* selector unsupported here */
    }
  }
  return false
}

/**
 * The visually-hidden / sr-only pattern, in any of its common spellings.
 *
 * HARD requirement from the P0 run-2 post-mortem: without it the agent reports
 * every screen-reader-only label as invisible text or a 1px target, which is
 * where its false positives came from. Checked on the element and a few
 * ancestors, because the pattern normally sits on a wrapper.
 *
 * EVERY branch here is a suppression primitive — what it returns true for gets
 * every measurement rule on the subtree deleted, and the `[sr-only]` that
 * results is legitimately emitted, so nothing downstream objects. Three of
 * these have now been found and closed. Any new branch has to answer the same
 * question before it is added: can a page reach this while its content stays
 * plainly painted?
 */
export function isSrOnly(el: Element): boolean {
  let node: Element | null = el
  let depth = 0
  // Computed once: it is a property of the element being judged, not of the
  // ancestor doing the hiding.
  const escapes = escapesOverflowClip(el)
  while (node && depth < 4) {
    const cs = styleOf(node)
    if (cs) {
      const clip = (cs.clip || '').replace(/\s+/g, '')
      const clipPath = (cs.clipPath || '').replace(/\s+/g, '')
      const positioned = cs.position === 'absolute' || cs.position === 'fixed'
      // `clip` REQUIRES positioning to do anything. On a static box it is a
      // visual no-op that getComputedStyle still reports — so this branch, when
      // it did not check position, was a pure-CSS way for a page to mark any
      // subtree sr-only and suppress every measurement rule on it while the
      // content stayed plainly visible. No script needed.
      if (positioned && (clip === 'rect(0px,0px,0px,0px)' || clip === 'rect(1px,1px,1px,1px)')) return true
      // `clip-path` does apply to static elements — and genuinely hides them, so
      // suppressing findings there is correct rather than exploitable.
      if (clipPath === 'inset(50%)' || clipPath === 'inset(100%)') return true
      const rect = node.getBoundingClientRect()
      const hidden = cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden'
      // The 1x1 clipping box every sr-only recipe uses — unless the element has
      // escaped the clip, which only `overflow` lets it do. `node !== el`
      // because an element that is ITSELF 1x1 and hidden is hidden whatever its
      // position is.
      if (positioned && hidden && rect.width <= 1 && rect.height <= 1 && !(node !== el && escapes)) return true
      // NOT here: the `left: -9999px` family. It was added and then removed,
      // and the reason is worth keeping. Everything this function returns true
      // for suppresses every measurement rule on the subtree, and the `[sr-only]`
      // that results is LEGITIMATELY emitted, so no defence downstream objects to
      // it. That makes each branch a suppression primitive, and a branch keyed on
      // an ancestor's box is one a page can reach without hiding anything:
      // `overflow: visible` is the default, so a descendant paints wherever it
      // likes while its parent's box sits off the canvas. Measured: an off-canvas
      // wrapper silenced contrast and target-size findings on plainly visible
      // children three levels down, from plain CSS. A negative `window.scrollX`
      // — ordinary in an RTL document — did it to the whole page.
      //
      // What it bought was the absence of contrast findings on off-screen text.
      // Noise is a smaller harm than a suppression primitive, so the noise stays.
    }
    node = node.parentElement
    depth++
  }
  return false
}

function shorthand(cs: CSSStyleDeclaration, prefix: string): string {
  const sides = ['top', 'right', 'bottom', 'left'].map((s) => cs.getPropertyValue(`${prefix}-${s}`).trim() || '0px')
  const [t, r, b, l] = sides
  if (t === r && r === b && b === l) return t
  if (t === b && r === l) return `${t} ${r}`
  return `${t} ${r} ${b} ${l}`
}

/** Properties a child inherits unchanged unless it says otherwise. Repeating an
 *  inherited value on every descendant is pure token cost: what a reviewer needs
 *  to see is where a value CHANGES. */
const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-weight', 'line-height'])

export function curatedStyles(el: Element): Record<string, string> | undefined {
  const cs = styleOf(el)
  if (!cs) return undefined
  const parentCs = el.parentElement ? styleOf(el.parentElement) : null
  const raw: Record<string, string> = {
    display: cs.display,
    // First family only: the fallback stack is noise the agent cannot act on.
    'font-family': (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(),
    'font-size': cs.fontSize,
    'font-weight': cs.fontWeight,
    'line-height': cs.lineHeight,
    color: cs.color,
    'background-color': cs.backgroundColor,
    padding: shorthand(cs, 'padding'),
    margin: shorthand(cs, 'margin'),
    overflow: cs.overflow,
  }
  if (cs.backgroundImage && cs.backgroundImage !== 'none') raw['background-image'] = cs.backgroundImage
  const out: Record<string, string> = {}
  for (const key of Object.keys(raw)) {
    const value = (raw[key] ?? '').trim()
    if (!value || value === 'none' || value === 'auto') continue
    if (value === 'rgba(0, 0, 0, 0)') continue
    if (STYLE_DEFAULTS[key]?.includes(value)) continue
    if (parentCs && INHERITED.has(key) && parentCs.getPropertyValue(key).trim() === cs.getPropertyValue(key).trim()) continue
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * `inert` on this element or any ancestor.
 *
 * A real HTML attribute with real subtree semantics — the browser removes the
 * subtree from interaction AND from the accessibility tree — so honouring it as
 * a contrast exemption is right. Reporting it is the part that was missing: it
 * was the only suppression in the pass that left NO trace at all, where even
 * the `aria-disabled` variants emit `[disabled]`. One attribute on one wrapper
 * deleted every contrast finding beneath it and the snapshot said nothing about
 * why, which is indistinguishable from a page with no defects.
 */
export function isInert(el: Element): boolean {
  let node: Element | null = el
  for (let depth = 0; node && depth < 32; depth++) {
    if (node.hasAttribute('inert')) return true
    node = parentOf(node)
  }
  return false
}

function ariaFlag(el: Element, attr: string): boolean {
  const value = el.getAttribute(attr)
  return value != null && value !== 'false'
}

/** Form-state semantics — the other HARD P0 run-2b requirement. */
export function stateOf(el: Element, opts?: { srOnly?: boolean; opacity?: number; inert?: boolean }): NodeState | undefined {
  const state: NodeState = {}
  const tag = el.tagName.toLowerCase()
  const isControl = tag === 'input' || tag === 'select' || tag === 'textarea'
  const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag

  if (isControl) state.type = type

  const control = el as Partial<HTMLInputElement>
  if (isControl && (type === 'checkbox' || type === 'radio')) state.checked = control.checked === true
  else if (ariaFlag(el, 'aria-checked')) state.checked = true

  if ((isControl && control.disabled === true) || ariaFlag(el, 'aria-disabled')) state.disabled = true

  if (isControl && type !== 'checkbox' && type !== 'radio' && type !== 'file' && type !== 'submit' && type !== 'button') {
    // The LENGTH of what the user typed, never the text of it. See
    // SnapshotNode['state'].valueLength for why this is not a heuristic.
    const value = typeof control.value === 'string' ? control.value : ''
    if (value.length > 0) state.valueLength = Math.min(value.length, VALUE_LENGTH_MAX)
  } else if (!isControl && holdsTypedText(el)) {
    // A `contenteditable` is a control that does not look like one. Its text is
    // withheld by `nameOf` for the same reason a textarea's is, so without this
    // it would report as an empty element and a review would see nothing there
    // at all — the length is what makes it legible again.
    state.type = 'contenteditable'
    const typed = el.textContent ?? ''
    if (typed.length > 0) state.valueLength = Math.min(typed.length, VALUE_LENGTH_MAX)
  }

  if (ariaFlag(el, 'aria-invalid')) state.ariaInvalid = true
  if (opts?.inert) state.inert = true
  if (opts?.srOnly) state.srOnly = true
  if (opts?.opacity != null && opts.opacity < 1) state.opacity = opts.opacity

  return Object.keys(state).length > 0 ? state : undefined
}

export interface Backdrop {
  /** What sits behind the element once every translucent layer is composited. */
  color: Rgba
  /** Colour stops of the nearest gradient behind it, if any — the case axe
   *  reports as `incomplete` and therefore never fails. */
  gradientStops: Rgba[]
  /** A non-gradient background-image (a photo, an SVG asset) is somewhere in the
   *  stack, so the composited colour is NOT what the text actually sits on. */
  hasImage: boolean
  /**
   * The element whose declaration made the backdrop unassessable — the one
   * carrying the image, or the layer that would not parse.
   *
   * Carried so the finding can be reported ONCE per declaring element instead of
   * once per text node. One `background-image` on a hero produced
   * `contrast-not-assessed` on all 300 paragraphs beneath it, and on a dense
   * page that pushed a genuine `critical button-name` off the wire: a coverage
   * note that costs real findings is a worse trade than the silence it replaced.
   */
  source: Element | null
  /**
   * A layer of this backdrop could not be READ.
   *
   * Distinct from `hasImage`, and the distinction is the finding: an image is a
   * backdrop we know we cannot judge; this is a backdrop we may have judged
   * WRONG. A `background-color` that does not parse used to be skipped, and a
   * skipped layer is indistinguishable from an absent one — so the composite
   * fell through to page white, and near-black text on a near-black surface
   * measured 21:1 and was reported as PASSING. The caller declines instead.
   */
  unreadable: boolean
}

const PAGE_WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }

/** `background-color` as a layer: a colour, `undefined` for "nothing painted
 *  here", or `null` for "there is a value and it did not parse" — which is not
 *  the same thing and must not be treated as it. */
function backgroundLayer(cs: CSSStyleDeclaration, currentColor: Rgba | null): Rgba | null | undefined {
  const raw = cs.backgroundColor
  // The initial value, in the two spellings engines use. Recognised by name so
  // the parser stays off the hot path for the overwhelmingly common case.
  if (!raw || raw === 'transparent' || raw === 'rgba(0, 0, 0, 0)') return undefined
  const bg = parseColor(raw, currentColor)
  if (!bg) return null
  return bg.a > 0 ? bg : undefined
}

export function backdropOf(el: Element): Backdrop {
  const layers: Rgba[] = [] // nearest first
  let gradientStops: Rgba[] = []
  let hasImage = false
  let unreadable = false
  let source: Element | null = null
  let node: Element | null = el

  for (let depth = 0; node && depth <= 64; depth++) {
    const cs = styleOf(node)
    if (cs) {
      // `currentcolor` in a background resolves to the colour of the element
      // that declares it, so it is re-resolved at each step of the climb.
      const nodeColor = parseColor(cs.color)
      const image = readBackgroundImage(cs.backgroundImage, nodeColor)
      if (gradientStops.length === 0) gradientStops = image.stops
      if (image.hasImage && !hasImage) {
        hasImage = true
        source = source ?? node
      }
      if (!image.parsed) {
        unreadable = true
        source = source ?? node
      }
      const bg = backgroundLayer(cs, nodeColor)
      if (bg === null) {
        unreadable = true
        source = source ?? node
      } else if (bg) {
        layers.push(bg)
        // Opaque: nothing behind it can show through, so the climb is done.
        if (bg.a >= 1) {
          if (depth === 0) return { color: bg, gradientStops, hasImage, unreadable, source }
          break
        }
      }
    }
    node = node.parentElement
  }

  // Nothing opaque was reached, so what is under the last translucent layer is
  // the canvas. White is assumed rather than declined: html/body's background
  // propagates to the canvas and both are IN the climb, so arriving here means
  // the stack really is translucent to the bottom — and declining on that would
  // decline on every ordinary page, almost none of which paint an opaque
  // background at all.
  let base = PAGE_WHITE
  for (let i = layers.length - 1; i >= 0; i--) base = composite(layers[i], base)
  return { color: base, gradientStops, hasImage, unreadable, source }
}

/** Text owned by this element rather than by a descendant. */
export function directText(el: Element): string {
  let out = ''
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i]
    if (child.nodeType === 3) out += child.nodeValue ?? ''
  }
  return out.replace(/\s+/g, ' ').trim()
}
