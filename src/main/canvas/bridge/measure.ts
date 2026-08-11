// The measurement pass: what the rendered page actually looks like, as opposed
// to what its source says (spec §10 P2, and the whole point of the P0 gate).
//
// Everything here reads layout and computed style. Nothing mutates the page —
// the bridge is read-only from the content side (D8).

import type { Rect, SnapshotNode } from '../../../shared/canvas'
import { composite, extractGradientStops, parseColor, type Rgba } from './color'

export type NodeState = NonNullable<SnapshotNode['state']>

const VALUE_MAX = 60

/** Field names that must never round-trip their value to the agent. The input
 *  type covers the honest cases; this covers the ones typed into a text box. */
const SECRET_HINT =
  /pass|secret|token|otp|cvv|cvc|\bpin\b|ccnum|card|ssn|auth|key|iban|routing|sort.?code|seed|mnemonic|phrase|private/i

/**
 * `autocomplete` values that ARE secrets, by definition.
 *
 * These are the standard tokens whose entire purpose is to say "this field holds
 * payment or credential data" — and they were the ones being missed, because the
 * name-based heuristic above never matched them: a hand-rolled `name="cardNumber"`
 * was redacted while the spec-compliant `autocomplete="cc-number"` handed the
 * model a live card number. Every `cc-*` token is payment data.
 */
const SECRET_AUTOCOMPLETE = /^(?:cc-|one-time-code$|current-password$|new-password$)/i

/**
 * Content that is a credential whatever the field around it is called.
 *
 * The backstop for the case no naming heuristic can reach: a key pasted into a
 * bare `<textarea>`. A snapshot goes verbatim into the model's context and from
 * there into transcripts, so the cost of missing one is permanent and the cost
 * of a false positive is a redacted field in a design review.
 */
const SECRET_VALUE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|rk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}/

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
 * The visually-hidden / sr-only pattern, in any of its common spellings.
 *
 * HARD requirement from the P0 run-2 post-mortem: without it the agent reports
 * every screen-reader-only label as invisible text or a 1px target, which is
 * where its false positives came from. Checked on the element and a few
 * ancestors, because the pattern normally sits on a wrapper.
 */
export function isSrOnly(el: Element): boolean {
  let node: Element | null = el
  let depth = 0
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
      // content stayed plainly visible. No script needed, and the resulting
      // `[sr-only]` is legitimately emitted, so no downstream defence sees it.
      if (positioned && (clip === 'rect(0px,0px,0px,0px)' || clip === 'rect(1px,1px,1px,1px)')) return true
      // `clip-path` does apply to static elements — and genuinely hides them, so
      // suppressing findings there is correct rather than exploitable.
      if (clipPath === 'inset(50%)' || clipPath === 'inset(100%)') return true
      const rect = node.getBoundingClientRect()
      const hidden = cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden'
      if (positioned && hidden && rect.width <= 1 && rect.height <= 1) return true
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

function ariaFlag(el: Element, attr: string): boolean {
  const value = el.getAttribute(attr)
  return value != null && value !== 'false'
}

/** Form-state semantics — the other HARD P0 run-2b requirement. */
export function stateOf(el: Element, opts?: { srOnly?: boolean; opacity?: number }): NodeState | undefined {
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
    const autocomplete = (el.getAttribute('autocomplete') || '').trim()
    const value = typeof control.value === 'string' ? control.value : ''
    // Everything a page uses to say what a field is FOR. `name` and `id` alone
    // missed the three most common ways to label a secret without naming it one:
    // the standard autocomplete token, the accessible label, and the placeholder.
    // A card number under `autocomplete="cc-number"`, an `aria-label="API secret"`
    // and a `placeholder="Recovery phrase"` all reached the model in full.
    const surface = [
      el.getAttribute('name') || '',
      el.id || '',
      autocomplete,
      el.getAttribute('aria-label') || '',
      el.getAttribute('placeholder') || '',
      // The visible label is often the ONLY thing identifying the field.
      el.closest?.('label')?.textContent || '',
    ].join(' ')
    const secret =
      type === 'password' ||
      type === 'hidden' ||
      SECRET_AUTOCOMPLETE.test(autocomplete) ||
      SECRET_HINT.test(surface) ||
      SECRET_VALUE.test(value)
    if (secret) {
      if (value.length > 0) state.value = '(redacted)'
    } else if (value.length > 0) {
      state.value = value.length > VALUE_MAX ? value.slice(0, VALUE_MAX - 1) + '…' : value
    }
  }

  if (ariaFlag(el, 'aria-invalid')) state.ariaInvalid = true
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
}

const PAGE_WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 }

function paintedImage(cs: CSSStyleDeclaration): boolean {
  const image = cs.backgroundImage
  return !!image && image !== 'none' && !/gradient\(/i.test(image)
}

export function backdropOf(el: Element): Backdrop {
  const layers: Rgba[] = [] // nearest first
  let gradientStops: Rgba[] = []
  let hasImage = false
  let node: Element | null = el.parentElement
  let depth = 0

  const own = styleOf(el)
  if (own) {
    gradientStops = extractGradientStops(own.backgroundImage)
    hasImage = paintedImage(own)
    const bg = parseColor(own.backgroundColor)
    if (bg && bg.a > 0) {
      layers.push(bg)
      if (bg.a >= 1) return { color: bg, gradientStops, hasImage }
    }
  }

  while (node && depth < 64) {
    const cs = styleOf(node)
    if (cs) {
      if (gradientStops.length === 0) gradientStops = extractGradientStops(cs.backgroundImage)
      if (!hasImage) hasImage = paintedImage(cs)
      const bg = parseColor(cs.backgroundColor)
      if (bg && bg.a > 0) {
        layers.push(bg)
        if (bg.a >= 1) break
      }
    }
    node = node.parentElement
    depth++
  }

  let base = PAGE_WHITE
  for (let i = layers.length - 1; i >= 0; i--) base = composite(layers[i], base)
  return { color: base, gradientStops, hasImage }
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
