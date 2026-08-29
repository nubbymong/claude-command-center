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

/**
 * THE ACCESSIBLE NAME IS A VALUE CHANNEL, and this is where it is closed.
 *
 * `state.valueLength` carries a length and never contents, the key relay refuses
 * editable targets, and `typedInto` carries identity only — and all three were
 * walked around by the accname algorithm, because accname is SPECIFIED to read
 * the value of an embedded control:
 *
 *   1. `<label>Amount <input id=min> to <input id=max></label>` — computing a
 *      name for `#min` traverses the label, and dom-accessibility-api answers
 *      each embedded textbox with `element.value`. The sibling's LIVE VALUE
 *      lands in `#min`'s name, up to the 80-character cap;
 *   2. `<div contenteditable role="button">` — `button` is a name-from-content
 *      role, so the name IS whatever the user has typed into it. `holdsTypedText`
 *      guarded only the `directText` fallback below, which this path never
 *      reaches.
 *
 * A name goes into `typedInto.hit`, into every `StampTarget`, into a stored
 * `AnnotationEvidence`, and back to the agent by default. So two rules, and both
 * are needed because they close different halves:
 *
 *   (a) STRUCTURAL: anything that HOLDS typed text — a text control, a textarea,
 *       a contenteditable — never gets a content-derived name at all. Its name is
 *       built here from label sources that cannot contain a value
 *       (`safeNameFor`), which in the ordinary `<label for=email>Email</label>`
 *       shape is the same string accname would have produced;
 *   (b) CONTAINMENT: for everything else, the accname is computed and then
 *       CHECKED against the live values around it. If it carries one, it is
 *       discarded and rebuilt from the safe sources. This is the backstop for
 *       every value-bearing path in accname nobody has enumerated — the rule is
 *       "no name may contain a value", not "no name may come from these three
 *       code paths".
 *
 * Rule (b) is deliberately blunt: a one-character value in a nearby field can
 * blank a name that merely contains that character. That is the fail-safe
 * direction — a missing label costs the agent a word, a leaked value costs the
 * user their data — and the scan is scoped to THIS element's own label sources,
 * so it cannot be triggered from across the page.
 */
export function nameOf(el: Element): string {
  // (a) The element itself holds what the user typed. Never content.
  //
  // The result goes through the SAME containment check branch (b) uses, so the
  // two branches are uniform. A page that scripts `aria-label = field.value` is
  // laundering a value through an attribute — page-authored laundering is a
  // stated non-goal of this file (the page runs first and can say anything), but
  // the check is one call, and a rule that holds on one branch and not the other
  // is the shape of every bug this module has had.
  if (holdsTypedText(el) || isTextControl(el)) {
    const safe = squash(safeNameFor(el))
    return safe && !nameCarriesTypedValue(el, safe) ? safe : ''
  }
  let name = ''
  try {
    name = computeAccessibleName(el)
  } catch {
    name = ''
  }
  if (name) {
    // (b) Computed — now prove it carries no value before it is allowed out.
    if (!nameCarriesTypedValue(el, name)) return squash(name)
    const safe = squash(safeNameFor(el))
    if (safe && !nameCarriesTypedValue(el, safe)) return safe
    return ''
  }
  // accname gives nothing for generic containers; their own text is what the
  // reviewer is actually looking at, so text leaves read by their content.
  //
  // Except where that text is not the page's — it is the USER'S. A `<textarea>`
  // holds its value as a child text node and a `contenteditable` holds whatever
  // was typed into it, so this fallback handed both to the agent under the name
  // of an accessible name. After the value itself stopped being carried this
  // was the one path a field's contents still had to the wire, and a pasted
  // private key went down it. (Unreachable now — the structural rule above
  // returns first — and kept because this function's contract is "no name is
  // ever content the user typed", not "the caller checks first".)
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

/** A control carrying a `value` property the user can type into. `select` is in:
 *  its value is chosen rather than typed, but it is still the user's answer and
 *  the option text is theirs to disclose, not ours. */
function isTextControl(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

/** How many label sources / controls one name computation will look at. Bounds
 *  a hostile page's ability to make naming one element expensive. */
const MAX_LABEL_SOURCES = 8
const MAX_VALUE_SOURCES = 32
/** How far up the tree an ancestor `<label>` is looked for. */
const MAX_LABEL_HOPS = 8

/** `getElementById` against the element's own root, so an id inside a shadow
 *  tree resolves there rather than against the top-level document. */
function byId(el: Element, id: string): Element | null {
  try {
    const root = el.getRootNode?.() as (Document | ShadowRoot) | undefined
    return root?.getElementById?.(id) ?? null
  } catch {
    return null
  }
}

/** The `<label>`s that name this control: every ancestor label, plus any
 *  `label[for=<id>]`. */
function labelsFor(el: Element): Element[] {
  const out: Element[] = []
  let cur: Element | null = el.parentElement
  for (let hops = 0; cur && hops < MAX_LABEL_HOPS && out.length < MAX_LABEL_SOURCES; hops++) {
    if (cur.tagName.toLowerCase() === 'label') out.push(cur)
    cur = cur.parentElement
  }
  const id = el.getAttribute?.('id')
  if (id) {
    try {
      const root = el.getRootNode?.() as (Document | ShadowRoot) | undefined
      // `CSS.escape` is not universally present in every embedded engine, and an
      // id with a quote in it would break the selector — so the labels are
      // filtered in JS rather than matched in a selector string.
      const labels = root?.querySelectorAll?.('label[for]')
      if (labels) {
        for (let i = 0; i < labels.length && out.length < MAX_LABEL_SOURCES; i++) {
          if (labels[i].getAttribute('for') === id) out.push(labels[i])
        }
      }
    } catch {
      /* no root to query — the ancestor labels are what there is */
    }
  }
  return out
}

/** The text of one label source with every embedded CONTROL removed.
 *
 *  Cloned and detached, so nothing the page renders is touched (D8) — the
 *  removal happens on a copy that never enters the document. Removing the
 *  controls is what makes this value-free: accname substitutes a control's value
 *  where the control sits, and there is no control left to substitute for. */
function labelTextWithoutValues(source: Element): string {
  try {
    const clone = source.cloneNode(true) as Element
    const controls = clone.querySelectorAll('input, textarea, select, [contenteditable]')
    for (let i = 0; i < controls.length; i++) controls[i].remove()
    return clone.textContent ?? ''
  } catch {
    return ''
  }
}

/**
 * A name built ONLY from sources that cannot carry what the user typed.
 *
 * In order of the accname algorithm's own preference, minus every step that
 * reads content: aria-label, aria-labelledby (with controls stripped), the
 * associated label (same), a button-family input's AUTHORED `value` (or an image
 * button's `alt`), then the page-authored placeholder and title. If none of
 * those exist the honest answer is no name — a control the page never labelled
 * is a finding in its own right, and the measurement pass reports it.
 */
function safeNameFor(el: Element): string {
  const ariaLabel = el.getAttribute?.('aria-label')
  if (ariaLabel && ariaLabel.trim().length > 0) return ariaLabel
  const labelledBy = el.getAttribute?.('aria-labelledby')
  if (labelledBy) {
    const parts: string[] = []
    for (const id of labelledBy.trim().split(/\s+/).slice(0, MAX_LABEL_SOURCES)) {
      const target = byId(el, id)
      // A labelledby target that IS a control names the element with its own
      // value under accname. Its text-without-controls is empty, so it simply
      // contributes nothing here.
      const text = target ? labelTextWithoutValues(target) : ''
      if (text.trim().length > 0) parts.push(text)
    }
    if (parts.length > 0) return parts.join(' ')
  }
  for (const label of labelsFor(el)) {
    const text = labelTextWithoutValues(label)
    if (text.trim().length > 0) return text
  }
  // A BUTTON-FAMILY input is named by its own `value`: `<input type="submit"
  // value="Pay now">` IS the Pay now button. Rule (a) had made it nameless, so a
  // trail read `click "button"` for the most consequential control on a checkout
  // page — a fidelity loss with no safety gain, because a button's value is a
  // label the page authored and not a thing anyone types into.
  //
  // THE TYPE GATE IS THE DEFENCE, and it is worth being exact about why, because
  // the obvious reading of this code is wrong. For the button family the API
  // value mode is "default", which means `.value` REFLECTS the content attribute
  // — property and attribute are one storage, and "read the attribute, not the
  // property" is a distinction without a difference for these types (measured).
  // What makes the read safe is that it happens ONLY for types whose value is a
  // label the page authored and not text anybody types. A `type="text"` input
  // never reaches this line, so a filled field cannot contribute its contents.
  //
  // `getAttribute` is still what is called, for the one window where the two DO
  // differ: an element whose type is being changed. And WHAT THAT DOES NOT
  // CLOSE, stated because it would otherwise be assumed: a page that flips a
  // filled text field to `type="submit"` at runtime. The HTML spec requires the
  // type change to copy the element's value into the content attribute (previous
  // API value mode "value" → new mode "default"), so afterwards a laundered
  // value is byte-identical to a genuine button label. No signal separates them,
  // and a page able to do that could equally assign `aria-label = field.value`.
  // That is the page-authored laundering the module header declares a non-goal:
  // the page runs first and can say anything. Measured in jsdom and pinned by a
  // test, so the limit is a recorded fact rather than an assumption.
  const inputType = el.tagName.toLowerCase() === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : ''
  if (inputType === 'submit' || inputType === 'button' || inputType === 'reset') {
    const authored = el.getAttribute('value')
    if (authored && authored.trim().length > 0) return authored
  }
  if (inputType === 'image') {
    const alt = el.getAttribute('alt')
    if (alt && alt.trim().length > 0) return alt
  }
  const placeholder = el.getAttribute?.('placeholder')
  if (placeholder && placeholder.trim().length > 0) return placeholder
  const title = el.getAttribute?.('title')
  if (title && title.trim().length > 0) return title
  return ''
}

function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Input types whose `value` is page-authored rather than user-entered.
 *
 * A DENYLIST here on purpose, against this file's usual habit, because the
 * fail-safe direction is inverted for this one question: an input type nobody
 * has heard of should be treated as though the user types into it, and an
 * allowlist of "typed" types would silently exempt the next one HTML adds.
 */
const NON_TYPED_INPUT_TYPES = new Set(['submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'hidden', 'file'])

/** Every live value that could have been substituted into `el`'s accessible
 *  name: controls inside it, inside its aria-labelledby targets, and inside the
 *  labels that name it. Bounded, and empty values are skipped — an empty string
 *  is contained by everything. */
function typedValuesAround(el: Element): string[] {
  const roots: Element[] = [el]
  const labelledBy = el.getAttribute?.('aria-labelledby')
  if (labelledBy) {
    for (const id of labelledBy.trim().split(/\s+/).slice(0, MAX_LABEL_SOURCES)) {
      const target = byId(el, id)
      if (target) roots.push(target)
    }
  }
  roots.push(...labelsFor(el))

  const values: string[] = []
  const push = (raw: string | null | undefined): void => {
    const value = normalizeForCompare(String(raw ?? ''))
    if (value.length > 0 && values.length < MAX_VALUE_SOURCES) values.push(value)
  }
  const readControl = (node: Element): void => {
    const tag = node.tagName.toLowerCase()
    if (tag === 'textarea' || tag === 'select') {
      push((node as HTMLInputElement).value)
      return
    }
    if (tag === 'input') {
      // A BUTTON-FAMILY input's `value` is its LABEL, not anybody's data — and
      // treating it as a value here would make the containment check reject the
      // very name `safeNameFor` just built from it ("Pay now" contains "Pay
      // now"). The exclusion list is the closed set of types whose value nobody
      // types; everything else — including an input type this build has never
      // heard of — is treated as typed, which is the fail-safe direction.
      if (!NON_TYPED_INPUT_TYPES.has((node.getAttribute('type') || 'text').toLowerCase())) {
        push((node as HTMLInputElement).value)
      }
      return
    }
    if (holdsTypedText(node)) push(node.textContent)
  }
  for (const root of roots) {
    if (values.length >= MAX_VALUE_SOURCES) break
    try {
      readControl(root)
      const controls = root.querySelectorAll('input, textarea, select, [contenteditable]')
      for (let i = 0; i < controls.length && values.length < MAX_VALUE_SOURCES; i++) readControl(controls[i])
    } catch {
      /* a root that cannot be queried contributes nothing */
    }
  }
  return values
}

/** Does this computed name carry any of those values? Compared on
 *  whitespace-normalised forms, because `squash` collapses runs and the two
 *  strings have to be comparable after it. */
function nameCarriesTypedValue(el: Element, name: string): boolean {
  const values = typedValuesAround(el)
  if (values.length === 0) return false
  const normalized = normalizeForCompare(name)
  if (normalized.length === 0) return false
  return values.some((value) => normalized.includes(value))
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
