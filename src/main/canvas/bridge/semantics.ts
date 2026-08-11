// Role and accessible name.
//
// P1 shipped hand-rolled heuristics for both. P2 keeps a (widened) implicit-role
// table as the always-available fallback, but prefers real implementations:
//   • name — dom-accessibility-api, the accname algorithm, always bundled (~30 KB)
//   • role — axe-core's HTML-AAM resolver, injected by the analysis chunk when it
//     loads, via setRoleResolver()
//
// The table stays because the bridge must answer hover queries instantly without
// pulling 500 KB of rules into the frame.

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

let roleResolver: ((el: Element) => string | null) | null = null

/** Installed by the analysis chunk once axe-core is in the frame. Authoritative
 *  when present: it implements HTML-AAM, including the cases the table cannot
 *  express (a `<section>` only being a region when named, `<td>` depending on its
 *  table's role, presentation inheritance). */
export function setRoleResolver(fn: ((el: Element) => string | null) | null): void {
  roleResolver = fn
}

export function hasRoleResolver(): boolean {
  return roleResolver !== null
}

export function squash(text: string | null | undefined): string {
  if (!text) return ''
  const out = String(text).replace(/\s+/g, ' ').trim()
  return out.length > NAME_MAX ? out.slice(0, NAME_MAX - 1) + '…' : out
}

function tableRole(el: Element): string {
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

export function roleOf(el: Element): string {
  if (roleResolver) {
    try {
      return roleResolver(el) || ''
    } catch {
      /* a resolver failure must never sink the snapshot */
    }
  }
  return tableRole(el)
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
  if (el.children.length === 0) return squash(directText(el))
  return ''
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
