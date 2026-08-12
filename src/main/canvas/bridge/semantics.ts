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

export function squash(text: string | null | undefined): string {
  if (!text) return ''
  const out = String(text).replace(/\s+/g, ' ').trim()
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
