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
 * THE CONTAINMENT SCAN IS DOCUMENT-WIDE, and that is the correction an
 * adversarial pass forced. It was scoped to "this element's own label sources",
 * which meant it had to model accname's traversal correctly — and three separate
 * reference mechanisms walked straight past it: `aria-owns` (not a label source
 * at all, but re-parents an owned control into the name), a DESCENDANT's
 * `aria-labelledby` (the scan read only the element's own), and simply having
 * more ids than the scan's bound. Every one of those is the same bug: an
 * enumeration of the ways a value can arrive is a list that the next mechanism
 * is not on.
 *
 * A CONTAINMENT SCAN WAS THE WRONG INSTRUMENT, and two rounds of re-attack said
 * so from both directions at once. Matching a computed name against serialized
 * values is matching a SERIALIZATION, so it is always one re-serialization away
 * from missing — a `<select>` names itself with the selected option's TEXT while
 * the scan held its VALUE ATTRIBUTE, and accname joins a contenteditable's block
 * children with spaces where `textContent` joins them with nothing. And doing it
 * PAGE-WIDE was a name eraser: one character typed into the app's own search box
 * blanked every button and heading on the page, which breaks re-anchoring
 * outright — a fingerprint's `name` is compared for exact equality against a
 * freshly computed one, so an emptied name reads to the user as "this element is
 * gone" for an element sitting in front of them. That is the failure
 * `canvas-page-text.ts` records as this pipeline's most expensive recurring bug.
 *
 * So the value is no longer MATCHED, it is REMOVED FROM THE COMPUTATION. An
 * element whose name comes from its CONTENT and which actually wraps a control
 * is named over a detached clone with the controls taken out: there is nothing
 * left to serialize, so nothing to serialize-match. A REFERENCE-based name
 * (`aria-labelledby` / `aria-owns` at a control elsewhere) has its reference
 * stripped on that same clone, and keeps a containment check scoped to EXACTLY
 * the controls this element references — never the page — so an unrelated search
 * box can no longer blank a Save button.
 *
 * Everything is gated behind one cheap pre-check, so an ordinary button that
 * wraps no control and references nothing pays a single `querySelector` and is
 * named exactly as accname names it.
 *
 * WHAT REMAINS, recorded rather than implied — both of the last two rounds
 * turned on a comment that asserted something nobody had measured:
 *
 *   - the clone is `cloneNode` off the LIVE tree, so a page that has redefined a
 *     getter (`textContent`, `value`, `cloneNode` itself) dictates what we read.
 *     It always did: this script shares a realm with the page, and the module
 *     header states the general case as a non-goal. What the clone removes is
 *     every ACCIDENTAL route, which is the whole of what was actually leaking;
 *   - the per-run memo went with the index, so there is no staleness window left
 *     to reason about — each name is computed against the DOM as it stands;
 *   - a name is still page-authored text. `aria-label = field.value` names
 *     whatever the page put there, and nothing here can tell that from a label.
 */
export function nameOf(el: Element): string {
  // (a) The element itself holds what the user typed. Never content.
  //
  // The result goes through the same scoped reference check branch (b) uses, so
  // the two branches are uniform. A page that scripts `aria-label = field.value`
  // is laundering a value through an attribute — page-authored laundering is a
  // stated non-goal of this file (the page runs first and can say anything), but
  // the check is one call, and a rule that holds on one branch and not the other
  // is the shape of every bug this module has had.
  if (holdsTypedText(el) || isTextControl(el)) return safeName(el)

  // (b) Everything else. The pre-check answers "could a value reach this name at
  // all"; when it cannot — which is the overwhelming majority of elements — the
  // name is accname's, untouched and unchecked.
  let source: Element | null = el
  if (reachesRiskyContent(el)) {
    source = valueFreeNameSource(el)
    // A source we could not sanitise is one we cannot reason about. This is
    // reachable WITHOUT hostile intent — an ordinary long form clears
    // MAX_REFERRERS — and it used to return `safeNameFor` unguarded, which was
    // the one path with no check on it at all.
    if (!source) return safeName(el)
  }
  let name = ''
  try {
    name = computeAccessibleName(source)
  } catch {
    name = ''
  }
  if (name) {
    // The scoped backstop: by construction the clone can no longer resolve a
    // control-bearing reference, so this should never fire. Kept because "should
    // never fire" is a claim about a traversal in somebody else's library.
    if (!nameCarriesReferencedValue(el, name)) return squash(name)
    return safeName(el)
  }
  // AN EMPTY NAME FROM A CLONE IS NOT EVIDENCE THERE IS NO NAME.
  //
  // accname resolves an id reference through `node.getRootNode().getElementById`,
  // and a DETACHED clone's root is an Element, which has no such method — so the
  // lookup throws and every `aria-labelledby`-named element (a dialog, a nav, a
  // tab) came back nameless. That is not a cosmetic loss: `fingerprintOf` mints
  // the name into the anchor a note re-anchors by, and it is compared for exact
  // equality, so an emptied name reads as "this element is gone".
  //
  // `safeNameFor` is the right answer here rather than a retry on the live
  // element: it resolves the reference against the LIVE root with the target's
  // controls stripped, so the dialog gets its heading back and a label made of a
  // filled field still contributes nothing.
  if (source !== el) {
    const safe = safeName(el)
    if (safe) return safe
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

/**
 * The value-free rebuild, guarded — the ONE way this module returns a
 * `safeNameFor` result, so no call site can forget the guard (one of them had).
 *
 * CHECKED BEFORE `squash`, not after. The candidate used to be cut to 80
 * characters first while the value it was checked against was full length, and a
 * needle longer than the haystack never matches — so anything between 80 and the
 * value's real length walked through every path that used this shape.
 *
 * DISCARDED ONLY ON EQUALITY, and that is the correction to a check that was
 * doing real damage. `safeNameFor`'s output is control-free by construction
 * (`cloneWithoutControls` answers null for a control source and strips
 * descendant controls otherwise), so a CONTAINMENT hit here never means a leak —
 * it means the user typed a word that also appears in a legitimate label. Under
 * the old rule, typing "Edit" into a field inside `<h2>Edit <input> profile</h2>`
 * blanked the dialog that heading names, and `resolveAnchors` then reported an
 * on-screen element as `found: false`. Equality still catches the one case worth
 * catching — a page assigning `aria-label = field.value`, where the name IS the
 * value.
 */
function safeName(el: Element): string {
  const raw = safeNameFor(el)
  if (!raw) return ''
  return safeNameIsAValue(el, raw) ? '' : squash(raw)
}

/** Elements whose own text is what a USER typed rather than what the page
 *  wrote. Their length is reported as `state.valueLength`; their contents are
 *  reported nowhere. */
export function holdsTypedText(el: Element): boolean {
  if (el.tagName.toLowerCase() === 'textarea') return true
  // A DECLARED editable: the page has said this element holds the user's text,
  // and accname agrees — step 2E reads a textbox's content AS ITS VALUE. Only
  // the two roles whose content IS the text; the other value-bearing roles
  // (combobox, listbox, slider, spinbutton) carry a value rather than typed
  // text and are handled by CONTROL_SELECTOR removal instead.
  const role = el.getAttribute?.('role')
  if (role) {
    const words = role.trim().toLowerCase().split(/\s+/)
    if (words.includes('textbox') || words.includes('searchbox')) return true
  }
  // `designMode` makes the WHOLE document editable, so every element's text is
  // potentially the user's. It belongs here rather than in a caller because this
  // function is the question four separate rules ask.
  try {
    if (el.ownerDocument?.designMode === 'on') return true
  } catch {
    /* a node with no document is not editable */
  }
  // EDITABILITY INHERITS, and asking only about the element's OWN attribute
  // missed that: the `<div contenteditable>` was correctly refused a name while
  // each block child inside it — one typed line each — was named with its own
  // text. (`isContentEditable` is the obvious property to read; jsdom does not
  // implement it, so the tests meant to prove this could not.)
  //
  // WALKED, not `closest`, and the difference is a name eraser. `closest`
  // terminates at the first element carrying the attribute AT ALL — but per HTML
  // the INVALID-VALUE DEFAULT is *inherit*, so `contenteditable="inherit"`, a
  // typo, or any unrecognised keyword answers nothing about editability and must
  // let the walk continue. Terminating there and reading "not false" made every
  // such wrapper editable, blanking every name in its subtree.
  //
  // The nearest ancestor with a RECOGNISED keyword wins, so an explicit
  // `contenteditable="false"` island inside an editable region is not editable —
  // which is what the attribute means.
  try {
    for (let cur: Element | null = el, hops = 0; cur && hops < MAX_EDITABLE_HOPS; hops++) {
      const declared = cur.getAttribute?.('contenteditable')
      if (typeof declared === 'string') {
        // NOT TRIMMED. The keywords are matched ASCII case-insensitively but not
        // whitespace-stripped, so `contenteditable="  "` is an INVALID value —
        // and the invalid-value default is *inherit*. Trimming first read it as
        // the empty-string keyword and made every such wrapper editable, which
        // blanked its whole subtree's names. Withholding rather than disclosing,
        // but a name eraser is the failure that breaks re-anchoring.
        const keyword = declared.toLowerCase()
        if (keyword === '' || keyword === 'true' || keyword === 'plaintext-only') return true
        if (keyword === 'false') return false
        // `inherit`, whitespace, and every other invalid keyword: keep climbing.
      }
      cur = parentOf(cur)
    }
  } catch {
    /* an exotic node — treat it as the page's own text */
  }
  return false
}

/** How far the editability walk climbs. Bounded like every other ancestor walk
 *  here; `parentOf` crosses shadow boundaries, so this covers a component's
 *  host chain too. */
const MAX_EDITABLE_HOPS = 32

/**
 * A control carrying a `value` the user supplies.
 *
 * `select` is in, and its treatment is worth stating exactly because the two
 * halves read as a contradiction otherwise: the SELECTED value is the user's
 * answer and is never disclosed (the select is named from its label, and its
 * value is in the containment index like any other), while an `<option>`'s TEXT
 * is the page's own list of choices and is emitted as ordinary page text like
 * any other label. What is withheld is which one they picked, not what the page
 * offered.
 */
function isTextControl(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

/** The elements an `aria-owns` re-parents into this one's content — a name
 *  source that is not a LABEL source, and was therefore in no list. */
function ownedElements(el: Element): Element[] {
  const ids = idList(el, 'aria-owns')
  const out: Element[] = []
  for (const id of ids.ids) {
    const target = byId(el, id)
    if (target) out.push(target)
  }
  return out
}

/** An id-reference attribute, split and bounded — and SAYING whether it was
 *  truncated, because a truncated list is the difference between "I looked at
 *  everything" and "I looked at the first eight". */
function idList(el: Element, attribute: string): { ids: string[]; truncated: boolean } {
  const raw = el.getAttribute?.(attribute)
  if (!raw) return { ids: [], truncated: false }
  const all = raw.trim().split(/\s+/).filter((id) => id.length > 0)
  return { ids: all.slice(0, MAX_LABEL_SOURCES), truncated: all.length > MAX_LABEL_SOURCES }
}

/** How many label sources / controls one name computation will look at. Bounds
 *  a hostile page's ability to make naming one element expensive. */
const MAX_LABEL_SOURCES = 8
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
  const clone = cloneWithoutControls(source)
  return clone?.textContent ?? ''
}

/**
 * THE ONE RULE, stated once and enforced everywhere below.
 *
 * A name-from-content element takes the value-free clone path if ANY of
 * {itself, a descendant, a slot-assigned node} is RISKY, and every bound in that
 * decision FAILS CLOSED — a truncated scan, an API that will not answer, or a
 * throw all mean "risky", never "fine".
 *
 * Five rounds of review found five variants of one bug, and each was the same
 * spot-level mistake: a pre-check asking `CONTROL_SELECTOR` where
 * `RISKY_SELECTOR` was meant, or a cap that answered `false`. The rule exists so
 * the next such spot is a deviation from something written down rather than an
 * omission nobody can see.
 */

/**
 * Every element whose text or value is the USER'S rather than the page's — and
 * so is deleted from the clone, not merely detected.
 *
 * The ARIA half is not decoration. accname reads a `role="textbox"`'s text
 * content AS ITS VALUE (step 2E), and `aria-valuetext` / `aria-valuenow` are the
 * user's answer on a slider or spinbutton by definition. `role="listbox"` is
 * here for POLICY parity: a native `<select>` withholds which option is
 * selected, and a rule that holds for one spelling of a widget and not the other
 * is not a policy, it is an accident of which one somebody listed.
 */
const CONTROL_SELECTOR =
  'input, textarea, select, [contenteditable],' +
  ' [role~="textbox"], [role~="searchbox"], [role~="combobox"], [role~="listbox"],' +
  ' [role~="slider"], [role~="spinbutton"], [aria-valuetext], [aria-valuenow],' +
  // accname's range branch (step 2F) reads getAttribute("value") for a
  // progressbar/meter/scrollbar, and that value WINS over the element's own
  // text — a password meter, a score, an upload progress the user drove all
  // read through as a name. `<progress>`/`<meter>` carry the implicit role; a
  // `<datalist>` is an implicit listbox that discloses a selected option only
  // where the page overrides its UA display:none. Listed by both role token and
  // element so a page cannot dodge the role with the native tag.
  ' [role~="progressbar"], [role~="meter"], [role~="scrollbar"], progress, meter, datalist'
/** …plus the two attributes that pull one of those into a name from elsewhere.
 *  ONE selector, so the pre-check is one native query — and the selector every
 *  risky-decision pre-check must use. `CONTROL_SELECTOR` alone answers "is this
 *  a control", which is a strictly narrower question than "can a value reach a
 *  name through this", and confusing the two is the recurring bug. */
const RISKY_SELECTOR = `${CONTROL_SELECTOR}, [aria-labelledby], [aria-owns]`
const REFERENCE_ATTRIBUTES = ['aria-labelledby', 'aria-owns'] as const
/** Referencing elements one sanitisation will rewrite. Past it the clone is
 *  abandoned and the value-free rebuild is used instead — fail closed. */
const MAX_REFERRERS = 64
/** Slots (and assigned nodes per slot) one risky-decision walk will look at.
 *  Exceeding it means the answer is RISKY, never "fine" — see
 *  `slotsReachRiskyContent`. Exported so the test that proves the bound fails
 *  closed can sit just past it rather than at a number that silently stops
 *  testing anything when the cap moves. */
export const MAX_SLOT_SCAN = 256

/** A detached copy with every control taken out. Detached, so nothing the page
 *  RENDERS is touched (D8): the removal happens on a copy that never enters the
 *  document. */
function cloneWithoutControls(source: Element): Element | null {
  // A CONTROL'S OWN BODY MAY NEVER NAME ANOTHER ELEMENT — and this is where that
  // becomes a shape question instead of a string comparison.
  //
  // Removing DESCENDANT controls left the case where the source IS one: a
  // `<textarea>` holds its value as its child text, a `contenteditable` holds
  // whatever was typed into it, and `safeNameFor` resolving an `aria-labelledby`
  // to either handed that text straight back as a label. Only the string match
  // stood there, and it has a ceiling — the candidate name is squashed to 80
  // characters BEFORE the check while the value is however long the user made
  // it, and a needle longer than the haystack never matches, so a 97-character
  // body shipped its first 79 characters.
  //
  // Answering `null` makes it structural: an element whose own body is user text
  // yields NO value-free name and contributes nothing. A reference to an `<h2>`
  // or a `<span>` still returns its text, which is why the reference-named roles
  // keep their names.
  if (isTextControl(source) || holdsTypedText(source)) return null
  try {
    const clone = source.cloneNode(true) as Element
    replaceSlotsWithAssignedContent(source, clone)
    // AFTER the slot expansion, so a control that arrived from a slot's assigned
    // nodes is taken out by the same pass that takes out the inline ones.
    const controls = clone.querySelectorAll(CONTROL_SELECTOR)
    for (let i = 0; i < controls.length; i++) controls[i].remove()
    return clone
  } catch {
    return null
  }
}

/**
 * Put a slot's ASSIGNED nodes into the clone in its place.
 *
 * A detached clone's `assignedNodes()` is empty, so deleting slots outright was
 * safe — and cost every element its slotted text: `<div role="button">Total
 * <slot></slot></div>` went from "Total Order total" to "Total", and a
 * slot-only element to `""`. A name that empties out IS the re-anchoring
 * failure, so "safe" was not free.
 *
 * The assigned elements are deep-cloned in, controls and all, and the caller's
 * control sweep then removes the controls — so the legitimate `<span>Order
 * total</span>` survives and the `<input>` beside it does not. Correlated by
 * document order against the LIVE subtree and run BEFORE anything is removed, so
 * the two slot lists cannot have diverged.
 */
function replaceSlotsWithAssignedContent(source: Element, clone: Element): void {
  // THE SOURCE MAY ITSELF BE THE SLOT, and every helper here used to miss that:
  // `querySelectorAll('slot')` matches descendants and never the element it is
  // called on. A `<slot role="button">` IS a named subject — `isMeaningful`
  // answers yes on the role attribute and the walk descends open shadow roots —
  // and its assigned `<input>`'s live value became its whole name, uncapped.
  //
  // Handled apart from the descendant case rather than folded into it: a root
  // slot cannot be REPLACED (the clone has to stay an element to be named), so
  // its children are swapped instead. Doing that first would also renumber the
  // descendant slot list, which is why this returns rather than falling through.
  if (source.tagName.toLowerCase() === 'slot') {
    const assigned = assignedNodesOf(source)
    // Nothing assigned means the browser renders the FALLBACK, so the clone's
    // own children are already the honest answer — leave them.
    if (assigned.length === 0) return
    try {
      while (clone.firstChild) clone.removeChild(clone.firstChild)
      for (const node of assigned) clone.appendChild(node.cloneNode(true))
    } catch {
      /* left to the caller's control sweep */
    }
    return
  }

  let liveSlots: NodeListOf<Element>
  let cloneSlots: NodeListOf<Element>
  try {
    liveSlots = source.querySelectorAll('slot')
    if (liveSlots.length === 0) return
    cloneSlots = clone.querySelectorAll('slot')
  } catch {
    return
  }
  const count = Math.min(liveSlots.length, cloneSlots.length, MAX_REFERRERS)
  for (let i = 0; i < count; i++) {
    const target = cloneSlots[i]
    const assigned = assignedNodesOf(liveSlots[i])
    try {
      for (const node of assigned) target.parentNode?.insertBefore(node.cloneNode(true), target)
      target.remove()
    } catch {
      /* a slot that will not be replaced is left to the control sweep */
    }
  }
}

/**
 * What a slot actually renders, bounded.
 *
 * `assignedNodes`, not `assignedElements`: accname reads the flattened tree,
 * which includes assigned TEXT. Taking elements only meant a slot filled with
 * bare text rebuilt as its FALLBACK — markup the user never saw — so
 * `<slot>Fallback</slot>` holding `Order total<input>` named "Fallback" instead
 * of "Order total".
 *
 * An engine that will not answer is treated as rendering nothing, which drops
 * the slot rather than guessing at it. (The RISK decision has already been made
 * separately, and it fails closed on the same condition.)
 */
function assignedNodesOf(slot: Element): Node[] {
  const assign = (slot as HTMLSlotElement).assignedNodes
  if (typeof assign !== 'function') return []
  try {
    return assign.call(slot as HTMLSlotElement, { flatten: true }).slice(0, MAX_SLOT_SCAN)
  } catch {
    return []
  }
}

/**
 * THE ONE DECISION: can a value reach this element's accessible name?
 *
 * Asked of {el itself, its descendants, its slot-assigned nodes} against
 * RISKY_SELECTOR — never CONTROL_SELECTOR, which answers the narrower "is this a
 * control" and is the mistake this file has now made five times. Every way of
 * NOT KNOWING answers true: a throw, an engine that will not report slot
 * assignment, or a scan that hit its cap.
 *
 * One native query for the overwhelming majority: a button that wraps nothing
 * and references nothing answers no and is then named exactly as accname names
 * it. The slot walk runs only when a `<slot>` is actually present, because that
 * is the one thing a DOM query cannot answer — accname reads the FLATTENED tree.
 */
function reachesRiskyContent(el: Element): boolean {
  try {
    if (matchesRisky(el)) return true
    if (el.querySelector(RISKY_SELECTOR) !== null) return true
    return slotsReachRiskyContent(el)
  } catch {
    // Cannot tell → assume it can. The sanitised clone is safe for an element
    // that never needed one; the reverse is not.
    return true
  }
}

/** Is this ONE element risky in itself? `matches` is belt-and-braces around the
 *  attribute reads: an engine without it must not answer "no". */
function matchesRisky(el: Element): boolean {
  try {
    for (const attribute of REFERENCE_ATTRIBUTES) if (el.hasAttribute?.(attribute)) return true
    if (typeof el.matches !== 'function') return true
    return el.matches(RISKY_SELECTOR)
  } catch {
    return true
  }
}

/**
 * Does any `<slot>` in reach render something risky?
 *
 * EL ITSELF IS IN THE LIST: `querySelectorAll` matches descendants and never the
 * element it is called on, so a `<slot role="button">` — a named subject in its
 * own right — answered "no slots here" and was named with its assigned control's
 * live value.
 *
 * TRUNCATION IS RISKY, not safe. The cap used to stop scanning and return false,
 * so a control on the ninetieth slot was simply never looked at — the same
 * fail-open shape as the id-list bound, which already fails closed.
 */
function slotsReachRiskyContent(el: Element): boolean {
  const slots: Element[] = []
  let truncated = false
  if (isSlotElement(el)) slots.push(el)
  try {
    const nested = el.querySelectorAll('slot')
    for (let i = 0; i < nested.length; i++) {
      if (slots.length >= MAX_SLOT_SCAN) {
        truncated = true
        break
      }
      slots.push(nested[i])
    }
  } catch {
    return true
  }
  for (const slot of slots) {
    const assign = (slot as HTMLSlotElement).assignedElements
    if (typeof assign !== 'function') {
      // An engine that will not say what a slot renders is one we cannot clear.
      truncated = true
      continue
    }
    let assigned: Element[]
    try {
      assigned = assign.call(slot as HTMLSlotElement, { flatten: true })
    } catch {
      return true
    }
    if (assigned.length > MAX_SLOT_SCAN) truncated = true
    for (let i = 0; i < assigned.length && i < MAX_SLOT_SCAN; i++) {
      const node = assigned[i]
      if (matchesRisky(node)) return true
      try {
        if (node.querySelector(RISKY_SELECTOR) !== null) return true
      } catch {
        return true
      }
    }
  }
  return truncated
}

function isSlotElement(el: Element): boolean {
  try {
    return el.tagName.toLowerCase() === 'slot'
  } catch {
    return false
  }
}


/**
 * A copy of `el` from which no control value can be read, for accname to name.
 *
 * Two removals, and they close different routes:
 *   - CONTAINED controls are deleted outright. This is what makes a `<select>`'s
 *     selected-option text and a `contenteditable`'s block-joined text
 *     unreachable: they are not compared against anything, they are not there;
 *   - a REFERENCE that resolves to a control-bearing target has its attribute
 *     removed — from the clone's root and from every descendant, because a
 *     descendant's `aria-labelledby` contributes its target's name to the
 *     parent's name-from-content. A reference to an ordinary heading is LEFT
 *     ALONE, which is why `<div role="dialog" aria-labelledby="title">` still
 *     reads its title.
 *
 * A truncated id list counts as control-bearing: the rebuild follows the first
 * MAX_LABEL_SOURCES while accname follows all of them, so the ninth id is
 * reachable by the name and not by us. Fail closed.
 *
 * THE CLONE CANNOT RESOLVE AN ID REFERENCE AT ALL — an earlier comment here
 * asserted the opposite and was simply wrong, which is how every reference-named
 * element came back nameless. accname looks an id up through
 * `node.getRootNode().getElementById(id)`; a detached clone's root is an
 * Element, which has no such method, so the lookup throws. The attribute removal
 * above is therefore belt-and-braces about WHICH references are dangerous, and
 * `nameOf` treats an empty result from a clone as "ask `safeNameFor` instead"
 * rather than as "there is no name".
 */
function valueFreeNameSource(el: Element): Element | null {
  const clone = cloneWithoutControls(el)
  if (!clone) return null
  try {
    const referrers: Element[] = []
    if (REFERENCE_ATTRIBUTES.some((a) => clone.hasAttribute(a))) referrers.push(clone)
    const nested = clone.querySelectorAll('[aria-labelledby], [aria-owns]')
    // More referencing elements than one sanitisation will rewrite: abandon the
    // clone rather than half-clean it.
    if (nested.length > MAX_REFERRERS) return null
    for (let i = 0; i < nested.length; i++) referrers.push(nested[i])

    for (const node of referrers) {
      for (const attribute of REFERENCE_ATTRIBUTES) {
        const list = idList(node, attribute)
        if (list.ids.length === 0 && !list.truncated) continue
        // `byId` resolves against `el`'s live root — the clone's ids are copies
        // and must not be the thing we look up.
        const dangerous = list.truncated || list.ids.some((id) => refersToControl(el, id))
        if (dangerous) node.removeAttribute(attribute)
      }
    }
    return clone
  } catch {
    return null
  }
}

function refersToControl(from: Element, id: string): boolean {
  const target = byId(from, id)
  return target !== null && reachesRiskyContent(target)
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
  const labelledBy = idList(el, 'aria-labelledby')
  if (labelledBy.ids.length > 0) {
    const parts: string[] = []
    for (const id of labelledBy.ids) {
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
  // NAME FROM CONTENT, value-free: the element's own text plus the text of
  // anything it `aria-owns`, every control removed from both. This is what the
  // rebuild returns for the shapes branch (b) rejects — a `<div role="button">`
  // wrapping a filled input still reads "Amount", and `<button aria-owns="card">
  // Pay</button>` still reads "Pay", instead of both going nameless.
  //
  // Never for an element that HOLDS typed text: its content is the user's.
  if (!isTextControl(el) && !holdsTypedText(el)) {
    const parts = [labelTextWithoutValues(el)]
    for (const owned of ownedElements(el)) parts.push(labelTextWithoutValues(owned))
    const joined = parts.map((p) => p.trim()).filter((p) => p.length > 0).join(' ')
    if (joined.length > 0) return joined
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
  // `getAttribute` is what is called anyway, but it buys NOTHING here and the
  // earlier comment claiming otherwise was wrong: because the value mode is
  // "default", ANY runtime write to `.value` reflects straight into the content
  // attribute — no type flip required. So what this reads is whatever the page
  // last put there, and a page that assigns `payButton.value = card.value` gets
  // that string named. Bounded, and the bound is the reason it is tolerable: the
  // string is PAINTED ON THE BUTTON, so it is not a channel for anything the
  // user cannot already see on their own screen. It is the same page-authored
  // laundering the module header declares a non-goal — a page able to do it
  // could equally assign `aria-label = field.value`. Measured in jsdom and
  // pinned by a test, so the limit is a recorded fact rather than an assumption.
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

/** One control's live value, or '' when it has none this rule cares about. */
function typedValueOf(node: Element): string {
  const tag = node.tagName.toLowerCase()
  if (tag === 'textarea' || tag === 'select') return normalizeForCompare(String((node as HTMLInputElement).value ?? ''))
  if (tag === 'input') {
    // A BUTTON-FAMILY input's `value` is its LABEL, not anybody's data — and
    // treating it as a value here would make the containment check reject the
    // very name `safeNameFor` just built from it ("Pay now" contains "Pay now").
    // The exclusion list is the closed set of types whose value nobody types;
    // everything else — including an input type this build has never heard of —
    // is treated as typed, which is the fail-safe direction.
    if (NON_TYPED_INPUT_TYPES.has((node.getAttribute('type') || 'text').toLowerCase())) return ''
    return normalizeForCompare(String((node as HTMLInputElement).value ?? ''))
  }
  if (holdsTypedText(node)) return normalizeForCompare(node.textContent ?? '')
  return ''
}

/**
 * The shortest value the reference check will match.
 *
 * A floor, because the check now runs only against controls THIS element
 * references — a small scope, but a two-character value would still blank a
 * legitimate name that merely contains those two characters, and blanking names
 * is what broke re-anchoring last round. Three is short enough that nothing
 * worth calling a disclosure sits under it.
 */
const MIN_REFERENCED_VALUE_CHARS = 3

/** Is this character part of a word, for the token-boundary test? */
function isWordChar(ch: string): boolean {
  return ch.length > 0 && /[\p{L}\p{N}]/u.test(ch)
}

/**
 * Does `needle` appear in `haystack` as a whole token?
 *
 * accname joins the parts of a name with spaces, so a substituted value lands
 * delimited. Requiring the delimiters is what keeps "Checkout" typed into a
 * search box from matching the Checkout button — the false positive that emptied
 * every name on the page.
 */
function containsToken(haystack: string, needle: string): boolean {
  for (let from = 0; from <= haystack.length - needle.length; ) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) return false
    const before = at === 0 ? '' : haystack.charAt(at - 1)
    const after = at + needle.length >= haystack.length ? '' : haystack.charAt(at + needle.length)
    if (!isWordChar(before) && !isWordChar(after)) return true
    from = at + 1
  }
  return false
}

/**
 * The values of the controls THIS element references — and nothing else.
 *
 * Scoped deliberately, and the scope is the fix: a page-wide scan blanked names
 * that had nothing to do with the field the user was typing in. Here the only
 * values that can reject a name are the ones the element itself points at, so an
 * unrelated search box is not in the conversation.
 */
function referencedControlValues(el: Element): string[] {
  const values: string[] = []
  const collect = (node: Element): void => {
    const own = typedValueOf(node)
    if (own.length > 0) values.push(own)
    try {
      const controls = node.querySelectorAll(CONTROL_SELECTOR)
      for (let i = 0; i < controls.length && values.length < MAX_LABEL_SOURCES * 4; i++) {
        const value = typedValueOf(controls[i])
        if (value.length > 0) values.push(value)
      }
    } catch {
      /* a target that cannot be queried contributes nothing */
    }
  }
  for (const attribute of REFERENCE_ATTRIBUTES) {
    for (const id of idList(el, attribute).ids) {
      const target = byId(el, id)
      if (target) collect(target)
    }
  }
  return values
}

/**
 * The scoped backstop. By construction the sanitised clone can no longer resolve
 * a control-bearing reference, so this should not fire — it is kept because
 * "should not fire" is a claim about a traversal inside somebody else's library,
 * and because branch (a) has no clone to rely on.
 */
function nameCarriesReferencedValue(el: Element, name: string): boolean {
  const normalized = normalizeForCompare(name)
  if (normalized.length === 0) return false
  const values = referencedControlValues(el)
  if (values.length === 0) return false
  return values.some((value) => value.length >= MIN_REFERENCED_VALUE_CHARS && containsToken(normalized, value))
}

/**
 * Is this value-free name simply a VALUE, whole?
 *
 * The test `safeName` uses, and it is equality rather than containment on
 * purpose — see `safeName` for why containment was blanking legitimate labels
 * and breaking re-anchoring. There is no length floor: an exact match is an
 * exact match at any length, and nothing legitimate is lost by refusing a label
 * that is character-for-character what the user just typed.
 */
function safeNameIsAValue(el: Element, name: string): boolean {
  const normalized = normalizeForCompare(name)
  if (normalized.length === 0) return false
  return referencedControlValues(el).some((value) => value === normalized)
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
