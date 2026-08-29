// @vitest-environment jsdom
// THE ACCESSIBLE NAME IS A VALUE CHANNEL — and this file is the proof it is
// closed.
//
// `state.valueLength` carries a length and never contents, the key relay refuses
// editable targets, and `typedInto` carries identity only. All three were walked
// around by the accname algorithm, which is SPECIFIED to substitute the value of
// an embedded control:
//
//   1. `<label>Amount <input id=min> to <input id=max></label>` — computing a
//      name for `#min` traverses the label, and dom-accessibility-api answers
//      each embedded textbox with `element.value`. A SIBLING FIELD'S LIVE VALUE
//      lands in `#min`'s name, and from there in `typedInto.hit`, in every
//      StampTarget, in a stored AnnotationEvidence, and back to the agent by
//      default;
//   2. `<div contenteditable role="button">` — `button` is a name-from-content
//      role, so the name IS whatever the user typed. The `holdsTypedText` guard
//      covered only the `directText` fallback, which that path never reaches.
//
// Every assertion below is the same assertion: seed a secret into a field, then
// look for it in what leaves the page. It must not be there — not in a name, not
// in a snapshot, not in an event.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { collectEvents, installBridge, stubLayout } from './canvas-bridge-harness'
import { captureSnapshot } from '../../../src/main/canvas/bridge/snapshot'
import { nameOf } from '../../../src/main/canvas/bridge/semantics'

/** Distinctive enough that finding it anywhere is unambiguous. */
const SECRET_MIN = 'SECRET-MIN-4111111111111111'
const SECRET_MAX = 'SECRET-MAX-hunter2-passphrase'
const SECRET_EDITABLE = 'SECRET-EDITABLE-my-private-key'
const SECRET_LABELLEDBY = 'SECRET-LABELLEDBY-token'
/** Only the containment backstop stands between these two and the wire. */
const SECRET_CARD = 'SECRET-CARD-9876543210987654'
const SECRET_TOTAL = 'SECRET-TOTAL-987.65-owing'
/** A TEXT input's `value` ATTRIBUTE — page-authored, and still never a name. */
const SECRET_ATTR = 'SECRET-ATTR-prefill'

beforeAll(() => {
  stubLayout({ x: 10, y: 20, width: 100, height: 30 })
  document.body.innerHTML = `
    <main>
      <!-- (1) two controls inside ONE wrapping label -->
      <label id="range-label">Amount <input id="min" type="text" /> to <input id="max" type="text" /></label>

      <!-- (2) a name-from-content role over an editable region -->
      <div id="editable-button" role="button" contenteditable="true"></div>

      <!-- (3) aria-labelledby pointing at a container that holds a control -->
      <div id="labelling">Card number <input id="card" type="text" /></div>
      <input id="cvv" type="text" aria-labelledby="labelling" />

      <!-- (4) the ordinary shape, which must keep working -->
      <label for="email">Email address</label>
      <input id="email" type="text" placeholder="you@example.com" />

      <!-- (5) BRANCH (b) ONLY: a name-from-content role WRAPPING a control.
           The div is neither a control nor editable, so rule (a) never fires and
           the containment check is the only thing standing here. This is the
           clickable-card pattern, and its name flows into contentClick trail
           targets. Raw accname answers "Amount <live value>". -->
      <div id="amount-card" role="button">Amount <input id="amt" type="text" /></div>

      <!-- (6) BRANCH (b) ONLY: aria-labelledby at a container holding a FILLED
           input. A <button> is not a control rule (a) covers, so again only the
           containment check applies. Its name flows into stamp targets. Raw
           accname answers "Pay <live value>". -->
      <div id="order-summary">Pay <input id="total" type="text" /></div>
      <button id="pay-button" aria-labelledby="order-summary"></button>

      <!-- (7) FIDELITY: button-family inputs are named by their AUTHORED value,
           and a text input's value attribute is never a name source. -->
      <input id="pay-submit" type="submit" value="Pay now" />
      <input id="reset-btn" type="reset" value="Start over" />
      <input id="search-img" type="image" alt="Search now" src="s.png" />
      <input id="prefilled" type="text" value="SECRET-ATTR-prefill" />
    </main>`
  installBridge()
})

beforeEach(() => {
  ;(document.getElementById('min') as HTMLInputElement).value = SECRET_MIN
  ;(document.getElementById('max') as HTMLInputElement).value = SECRET_MAX
  ;(document.getElementById('card') as HTMLInputElement).value = SECRET_LABELLEDBY
  ;(document.getElementById('editable-button') as HTMLElement).textContent = SECRET_EDITABLE
  ;(document.getElementById('amt') as HTMLInputElement).value = SECRET_CARD
  ;(document.getElementById('total') as HTMLInputElement).value = SECRET_TOTAL
})

const SECRETS = [SECRET_MIN, SECRET_MAX, SECRET_EDITABLE, SECRET_LABELLEDBY, SECRET_CARD, SECRET_TOTAL, SECRET_ATTR]

function assertNoSecret(where: string, text: string): void {
  for (const secret of SECRETS) {
    expect(`${where}: ${text}`).not.toContain(secret)
  }
}

describe('nameOf never returns a typed value', () => {
  it('a control inside a shared label is named by the LABEL, not by its siblings', () => {
    const min = nameOf(document.getElementById('min')!)
    const max = nameOf(document.getElementById('max')!)
    assertNoSecret('min', min)
    assertNoSecret('max', max)
    // The page's own words survive: the label text with the controls removed.
    expect(min).toContain('Amount')
    expect(min).toContain('to')
  })

  it('a contenteditable with a name-from-content role gets no name from its content', () => {
    const name = nameOf(document.getElementById('editable-button')!)
    assertNoSecret('editable-button', name)
    // It has no aria-label, no title and no label, so the honest answer is none.
    expect(name).toBe('')
  })

  it('an aria-labelledby target that CONTAINS a control contributes only its text', () => {
    const name = nameOf(document.getElementById('cvv')!)
    assertNoSecret('cvv', name)
    expect(name).toContain('Card number')
  })

  it('still names an ordinarily-labelled control the way it always did', () => {
    expect(nameOf(document.getElementById('email')!)).toBe('Email address')
  })

  it('THE CONTAINMENT BACKSTOP: a name-from-content role WRAPPING a control (branch b)', () => {
    // Rule (a) does not fire here — a `<div role="button">` is neither a control
    // nor editable — so this is the case only `nameCarriesTypedValue` protects.
    // Raw accname answers "Amount SECRET-CARD-…"; measured, not assumed.
    const name = nameOf(document.getElementById('amount-card')!)
    assertNoSecret('amount-card', name)
  })

  it('THE CONTAINMENT BACKSTOP: aria-labelledby at a container holding a filled input (branch b)', () => {
    // Same: a `<button>` is not a control rule (a) covers. Raw accname answers
    // "Pay SECRET-TOTAL-…".
    const name = nameOf(document.getElementById('pay-button')!)
    assertNoSecret('pay-button', name)
  })

  it('names a button-family input by its AUTHORED value, and an image button by its alt', () => {
    // Rule (a) had made these nameless, so a trail read `click "button"` for the
    // most consequential control on a checkout page.
    expect(nameOf(document.getElementById('pay-submit')!)).toBe('Pay now')
    expect(nameOf(document.getElementById('reset-btn')!)).toBe('Start over')
    expect(nameOf(document.getElementById('search-img')!)).toBe('Search now')
  })

  it('reads a value ONLY for the button family — a typed field never reaches that line', () => {
    // The type gate is what makes the read safe, not attribute-vs-property: for
    // the button family the two are one storage (API value mode "default"), so
    // the distinction does not exist there. What matters is that a `type="text"`
    // input never gets here, whether its text is live or authored.
    const typed = document.createElement('input')
    typed.type = 'text'
    typed.setAttribute('value', 'SECRET-AUTHORED-default')
    document.body.appendChild(typed)
    typed.value = 'SECRET-LIVE-typed'
    expect(nameOf(typed)).toBe('')
    typed.remove()
  })

  it('RECORDS the limit: a runtime type-flip is page-authored laundering, and is not closed', () => {
    // Measured, not assumed. The HTML spec requires a type change out of the
    // "value" API mode to COPY the element's value into the content attribute,
    // so after the flip the attribute and the property are the same string and a
    // laundered value is byte-identical to a genuine button label. There is no
    // signal that separates them, and a page able to do this could equally set
    // `aria-label` to the typed text — the non-goal the module header states.
    //
    // Pinned so the boundary is a recorded fact rather than an assumption: if a
    // future engine stops copying the attribute, this test fails and the comment
    // in `safeNameFor` gets to be stronger.
    const flipped = document.createElement('input')
    flipped.type = 'text'
    document.body.appendChild(flipped)
    flipped.value = 'SECRET-FLIP-typed-by-the-user'
    expect(flipped.getAttribute('value')).toBeNull()
    // Before the flip the accidental path is closed: no attribute, no name.
    expect(nameOf(flipped)).toBe('')
    flipped.type = 'submit'
    expect(flipped.getAttribute('value')).toBe('SECRET-FLIP-typed-by-the-user')
    flipped.remove()
  })

  it('never uses a TEXT input’s value attribute as a name', () => {
    // The attribute is page-authored, but it is one keystroke away from the live
    // property and the two are trivially confused. Only the button family reads
    // it, so a text input with no label has no name.
    const name = nameOf(document.getElementById('prefilled')!)
    assertNoSecret('prefilled', name)
    expect(name).toBe('')
  })

  it('prefers aria-label, and falls back to the placeholder when nothing labels the field', () => {
    const bare = document.createElement('input')
    bare.type = 'text'
    bare.placeholder = 'Search orders'
    bare.value = 'SECRET-BARE-value'
    document.body.appendChild(bare)
    expect(nameOf(bare)).toBe('Search orders')
    bare.setAttribute('aria-label', 'Order search')
    expect(nameOf(bare)).toBe('Order search')
    bare.remove()
  })
})

describe('nothing that leaves the page carries a value', () => {
  it('not the semantic snapshot', async () => {
    const result = await captureSnapshot({ analysis: false })
    assertNoSecret('snapshot', JSON.stringify(result))
    // And the snapshot is not empty — the guard must not be passing by silence.
    expect(JSON.stringify(result)).toContain('Amount')
  })

  it('not a typedInto event', async () => {
    const min = document.getElementById('min') as HTMLInputElement
    const events = collectEvents('typedInto', 300)
    min.dispatchEvent(new Event('input', { bubbles: true }))
    const seen = await events
    expect(seen).toHaveLength(1)
    assertNoSecret('typedInto', JSON.stringify(seen[0]))
  })

  it('not a contentClick event', async () => {
    const max = document.getElementById('max') as HTMLInputElement
    // The bridge hit-tests the point; jsdom has no layout, so point at the
    // element directly.
    ;(document as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => max
    const events = collectEvents('contentClick', 300)
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const seen = await events
    expect(seen.length).toBeGreaterThan(0)
    assertNoSecret('contentClick', JSON.stringify(seen))
    delete (document as { elementFromPoint?: unknown }).elementFromPoint
  })
})
