// Role and accessible name.
//
// P1 shipped hand-rolled heuristics for both. P2 keeps the (widened) implicit-role
// table and takes the accessible NAME from dom-accessibility-api — the accname
// algorithm, always bundled (~30 KB).
//
// Roles deliberately do NOT come from axe. `axe.commons.aria.getRole` is an
// undocumented internal that only works between axe.setup() and axe.teardown():
// called outside a run it throws, and the adversarial pass proved that swallowing
// that throw emptied the role on every node of every production snapshot. A table
// that always works beats a better resolver that works only sometimes.

import { computeAccessibleName } from 'dom-accessibility-api'
import { stripFormatControls } from '../../../shared/canvas-page-text'
import { directText } from './measure'

const NAME_MAX = 80

const IMPLICIT_ROLES: Record<string, string> = {
  button: 'button', select: 'combobox', textarea: 'textbox', img: 'img',
  nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
  aside: 'complementary', form: 'form', table: 'table', ul: 'list', ol: 'list',
  li: 'listitem', dialog: 'dialog', hr: 'separator', progress: 'progressbar',
  summary: 'button', p: 'paragraph', h1: 'heading', h2: 'heading', h3: 'heading',
  h4: 'heading', h5: 'heading', h6: 'heading', article: 'article', fieldset: 'group',
  label: 'label', option: 'option', output: 'status', meter: 'meter',
  td: 'cell', th: 'columnheader', tr: 'row', thead: 'rowgroup', tbody: 'rowgroup',
  caption: 'caption', legend: 'legend', figure: 'figure', details: 'group',
  search: 'search', menu: 'list', dd: 'definition', dt: 'term',
}

const INPUT_ROLES: Record<string, string> = {
  checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
  search: 'searchbox', button: 'button', submit: 'button', reset: 'button',
  image: 'button', file: 'button', email: 'textbox', tel: 'textbox', url: 'textbox',
  password: 'textbox', hidden: '',
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'slider', 'spinbutton', 'textbox', 'searchbox', 'combobox',
  'listbox', 'treeitem',
])

const INTERACTIVE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'a', 'summary'])

const SKIP_TAGS = new Set(['script', 'style', 'template', 'meta', 'link', 'head', 'noscript', 'title', 'base'])

/**
 * An accessible name (or a title, or a text leaf) as BOTH sides of the canvas
 * pipeline keep it.
 *
 * The whitespace collapse is the visible half; the format-control strip is the
 * half that has to be here or anchoring breaks. The host cleans every
 * page-authored string it STORES with `canvasPageText`
 * (src/renderer/utils/canvas-geometry-guard.ts), and a stored fingerprint is
 * re-found by comparing that stored name to a freshly computed one for exact
 * equality. While only the host stripped, "<woman>ZWJ<computer> Developer"
 * stored as "<woman><computer> Developer" and recomputed with the joiner
 * intact, so it never matched again — the note showed "needs re-pointing" on
 * every re-render although its element was right there (adversarial re-attack,
 * 2026-08-15).
 *
 * Order matters and is not interchangeable:
 *   1. collapse whitespace FIRST — tab/newline/CR/FF/VT are format controls
 *      too, and stripping them ahead of the collapse welds two words together
 *      ("Save\nNow" -> "SaveNow" rather than "Save Now");
 *   2. strip what is left of the class — the joiners, the bidi controls, the
 *      zero-width space, the BOM;
 *   3. collapse once more, because a stripped character can leave a gap
 *      between two spaces, and trim.
 * Nothing of the class may survive step 3: the host re-applies exactly it to
 * the value it stores, and the two strings are then compared for equality.
 *
 * The 80-character cap sits under the host's 120, so its slice is a no-op and
 * cannot re-introduce a difference. (U+2026, the ellipsis this appends, is Po
 * and is not part of the class.)
 */
export function squash(text: string | null | undefined): string {
  if (!text) return ''
  const collapsed = String(text).replace(/\s+/g, ' ')
  const out = stripFormatControls(collapsed).replace(/\s+/g, ' ').trim()
  return out.length > NAME_MAX ? out.slice(0, NAME_MAX - 1) + '…' : out
}

export function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit.trim().split(/\s+/)[0].toLowerCase()
  const tag = el.tagName.toLowerCase()
  if (tag === 'a') return el.hasAttribute('href') ? 'link' : ''
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase()
    return Object.prototype.hasOwnProperty.call(INPUT_ROLES, type) ? INPUT_ROLES[type] : 'textbox'
  }
  if (tag === 'section') {
    return el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ? 'region' : ''
  }
  return Object.prototype.hasOwnProperty.call(IMPLICIT_ROLES, tag) ? IMPLICIT_ROLES[tag] : ''
}

export function nameOf(el: Element): string {
  let name = ''
  try {
    name = computeAccessibleName(el)
  } catch {
    name = ''
  }
  if (name) return squash(name)
  // accname gives nothing for generic containers; their own text is what the
  // reviewer is actually looking at, so text leaves read by their content.
  //
  // Except where that text is not the page's — it is the USER'S. A `<textarea>`
  // holds its value as a child text node and a `contenteditable` holds whatever
  // was typed into it, so this fallback handed both to the agent under the name
  // of an accessible name. After the value itself stopped being carried this
  // was the one path a field's contents still had to the wire, and a pasted
  // private key went down it.
  if (el.children.length === 0 && !holdsTypedText(el)) return squash(directText(el))
  return ''
}

/** Elements whose own text is what a USER typed rather than what the page
 *  wrote. Their length is reported as `state.valueLength`; their contents are
 *  reported nowhere. */
export function holdsTypedText(el: Element): boolean {
  if (el.tagName.toLowerCase() === 'textarea') return true
  const editable = el.getAttribute?.('contenteditable')
  return typeof editable === 'string' && editable.toLowerCase() !== 'false'
}

export function isInteractive(el: Element, role: string): boolean {
  if (INTERACTIVE_ROLES.has(role)) return true
  const tag = el.tagName.toLowerCase()
  if (tag === 'a') return el.hasAttribute('href')
  if (INTERACTIVE_TAGS.has(tag)) return true
  return el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1'
}

export function isSkipped(el: Element): boolean {
  return SKIP_TAGS.has(el.tagName.toLowerCase())
}

/**
 * The element one level UP, crossing out of a shadow tree when it runs out of
 * ordinary parents.
 *
 * `parentElement` is null at the top of a shadow tree, so every ancestor walk in
 * this bridge stopped dead at the shadow boundary and reported the contents of a
 * web component as if they hung off nothing. `getRootNode().host` is the way
 * out; guarded because a detached subtree's root is a DocumentFragment with no
 * host, and the document's root has none either.
 */
export function parentOf(el: Element): Element | null {
  const parent = el.parentElement
  if (parent) return parent
  const root = el.getRootNode?.()
  const host = (root as ShadowRoot | undefined)?.host
  return host && host !== el ? host : null
}

/**
 * A custom element whose content this walk cannot see AT ALL.
 *
 * `shadowRoot` is null for a CLOSED root exactly as it is for no root, so the
 * only signal left is circumstantial and this is it: an element with a hyphen in
 * its name (so, a custom element), painting a box, holding no light children and
 * no text of its own, and offering no open root to descend into. Something is on
 * screen and the tree cannot say what.
 *
 * Deliberately narrow. Every clause is there to keep an ordinary light-DOM
 * component — which is most of them — from tripping it: those have children.
 */
export function hidesItsContent(el: Element): boolean {
  if (el.tagName.indexOf('-') < 0) return false
  // Belt and braces, not load-bearing: the one caller only reaches this when
  // `shadowRoot` is already null, so a mutation that deletes this line survives
  // the suite. Recorded rather than tested around — a genuinely equivalent
  // mutant should be labelled, and the alternative is a function whose contract
  // is "correct only if the caller checks first".
  if (el.shadowRoot) return false
  // NOT the same test as the caller's. The caller counts EMITTED nodes; this
  // counts DOM children, and a component holding one unremarkable div has one
  // of the latter and none of the former. Its content is readable — there is
  // just nothing in it worth a line — so it must not be reported as unreadable.
  if (el.children.length > 0) return false
  return directText(el).length === 0
}

/**
 * Whether a node earns a line in the snapshot. Wider than P1's hover-oriented
 * filter: text leaves are in, because contrast and clipping findings live on
 * them and a tree that omits them cannot carry the evidence.
 */
export function isMeaningful(el: Element): boolean {
  if (!el || el.nodeType !== 1) return false
  if (isSkipped(el)) return false
  const tag = el.tagName.toLowerCase()
  if (el.hasAttribute('data-ux-id')) return true
  if (el.hasAttribute('role') || el.hasAttribute('tabindex')) return true
  if (tag === 'a' && el.hasAttribute('href')) return true
  if (INTERACTIVE_TAGS.has(tag) || tag === 'section' || tag === 'svg') return true
  if (Object.prototype.hasOwnProperty.call(IMPLICIT_ROLES, tag)) return true
  return el.children.length === 0 && directText(el).length > 0
}
