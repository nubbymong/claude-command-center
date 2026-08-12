// The measurement pass: what the rendered page actually looks like, as opposed
// to what its source says (spec §10 P2, and the whole point of the P0 gate).
//
// Everything here reads layout and computed style. Nothing mutates the page —
// the bridge is read-only from the content side (D8).

import type { Rect, SnapshotNode } from '../../../shared/canvas'
import { composite, extractGradientStops, parseColor, type Rgba } from './color'

export type NodeState = NonNullable<SnapshotNode['state']>

const VALUE_MAX = 60

/**
 * Split a field identifier into words, so a word boundary means the same thing
 * whatever naming convention the page uses.
 *
 * `cardNumber`, `card_number`, `CARD-NUMBER` and `APIKey` all become the same
 * lowercase token stream. Without this, matching has to fall back to unbounded
 * substrings, and unbounded substrings are what made `key` match `keywords`.
 */
function words(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .trim()
}

/**
 * Names that mean "credential" wherever they appear — including in prose a
 * human wrote for other humans. Every entry here has no innocent reading, so
 * it is safe to match against a label or a placeholder.
 *
 * Written against the output of `words()`, so a single space matches every
 * separator the page might have used and no `i` flag is needed.
 */
const SECRET_STRONG = new RegExp(
  [
    'secret',
    'passw', // password, passwd, passwords
    'passphrase',
    'passcode',
    'credential',
    'mnemonic',
    'social security',
    'private key',
    'security code',
    'sort code',
    'authorization',
    '\\bcvv\\b',
    '\\bcvc\\b',
    '\\bccnum\\b',
    '\\bssn\\b',
    '\\biban\\b',
    '\\botp\\b',
    '\\btotp\\b',
    'one time (?:code|password|passcode)',
    '(?:seed|recovery|backup|secret|mnemonic) (?:phrase|words?)',
    '(?:card|cc) (?:numbers?|num|no|code|pin|expiry|exp)',
    '(?:credit|debit|payment|bank) cards?',
    'routing (?:number|no)',
    'account number',
    'api (?:keys?|tokens?|secrets?)',
  ].join('|'),
)

/**
 * Names that mean "credential" only as WHOLE WORDS, and only on a surface the
 * PAGE chose as a machine identifier.
 *
 * These are the words with a common innocent reading. Matched as unbounded
 * substrings against human prose they redacted 20 of 23 ordinary fields —
 * `key` inside `keywords`, `card` inside "Card title", `pin` inside "Pin to
 * top", `auth` inside `authorName` — and field values are primary evidence in
 * a design review, so a card-authoring form became unreviewable. Bare `card`
 * and bare `auth` are gone entirely: the cases that matter reach this through
 * `autocomplete="cc-*"`, "card number", `authToken` and `authKey`.
 */
const SECRET_FIELD_NAME = /\b(?:keys?|tokens?|pins?|pass|creds?|pwd)\b/

/**
 * The same risky words, allowed back into prose when the prose is NOTHING BUT
 * one of them.
 *
 * `<label>PIN</label>` names a PIN field; `aria-label="Pin to top"` names a
 * button, and the difference is that the second one is a sentence. Tested
 * against each surface separately rather than against all of them joined, so a
 * long placeholder cannot dilute a one-word label out of matching.
 */
const SECRET_PROSE_EXACT = /^(?:pins?|keys?|tokens?|pass|creds?|pwd|passcode)$/

/**
 * A page controls every surface below and none of them has a length limit, so
 * the cost of deciding "is this a secret?" is bounded here rather than by the
 * page. This is the bound that matters: `words()` rewrites its input three
 * times over and then several patterns are matched against the result, PER
 * CONTROL. 400 controls under one 540 KB label cost 2,417 ms of synchronous
 * work on the page's thread unclamped, and 240 ms clamped.
 *
 * Set high on purpose. It is a ceiling on the absurd, not a budget: anything
 * tighter would start missing a hint that sits after a paragraph of help text
 * inside a wrapping `<label>`, and a missed secret is permanent.
 */
const SURFACE_MAX = 4096

function clampSurface(value: string | null | undefined): string {
  return value ? value.slice(0, SURFACE_MAX) : ''
}

/** The wrapping label's text, read at most once per label per capture. */
function labelTextFor(el: Element): string {
  const label = el.closest?.('label')
  if (!label) return ''
  const cache = labelTextCache
  const hit = cache?.get(label)
  if (hit !== undefined) return hit
  const text = clampSurface(label.textContent)
  cache?.set(label, text)
  return text
}

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
 * single synchronous capture is safe; `resetCaptureCaches()` runs at the start of
 * each one so a later capture never reads stale layout.
 */
let styleCache: WeakMap<Element, CSSStyleDeclaration> | null = null

/**
 * Per-capture memo for a wrapping label's text, on the same lifecycle.
 *
 * `textContent` rebuilds the whole subtree's string on EVERY read, and one
 * `<label>` may wrap many controls: the page writes that content once and the
 * bridge would otherwise read it once per control.
 *
 * Honestly: this is not the fix for the stall — `SURFACE_MAX` is, and removing
 * this memo changes nothing measurable under jsdom (240 ms either way), whose
 * `textContent` is evidently far cheaper than a real engine's. It is kept
 * because the asymmetry it closes is a property of the DOM rather than of the
 * harness, and it costs one WeakMap. The claim stops there.
 */
let labelTextCache: WeakMap<Element, string> | null = null

export function resetCaptureCaches(): void {
  styleCache = new WeakMap()
  labelTextCache = new WeakMap()
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
      // The `left: -9999px` family. Keyed on where the box ACTUALLY ENDS UP in
      // page coordinates, not on the declaration: a page cannot claim this
      // without genuinely being off the canvas, which is what separates it from
      // the `clip` trap above. Page coordinates, so scroll position is not part
      // of the answer, and no ordinary content sits at a negative page x.
      // A real box is required before "off the canvas" means anything: an
      // element with no size is at 0,0 with width 0, which satisfies the
      // inequality while being nowhere in particular.
      const box = boxOf(node)
      if (box.width > 0 && box.height > 0 && (box.x + box.width <= 0 || box.y + box.height <= 0)) return true
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
    // Two surfaces, because they carry different amounts of evidence.
    //
    // An IDENTIFIER is a name the page chose for a machine to read; nobody
    // writes `name="pin"` for a field that pins a post. PROSE is written for a
    // human — "Pin to top", "Card title", "Search by keyword" — and reading it
    // as a field name is how the redaction started eating ordinary content.
    // Only the unambiguous stems are matched against prose.
    const identifiers = words([el.getAttribute('name'), el.id, autocomplete].map(clampSurface).join(' '))
    const prose = [
      clampSurface(el.getAttribute('aria-label')),
      clampSurface(el.getAttribute('placeholder')),
      // The visible label is often the ONLY thing identifying the field.
      labelTextFor(el),
    ].map(words)
    const secret =
      type === 'password' ||
      type === 'hidden' ||
      SECRET_AUTOCOMPLETE.test(autocomplete) ||
      SECRET_STRONG.test(identifiers) ||
      SECRET_FIELD_NAME.test(identifiers) ||
      prose.some((surface) => SECRET_STRONG.test(surface) || SECRET_PROSE_EXACT.test(surface)) ||
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
