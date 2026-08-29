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
import { MAX_SLOT_SCAN, nameOf } from '../../../src/main/canvas/bridge/semantics'
import type { SnapshotNode } from '../../../src/shared/canvas'

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

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

/** A throwaway subtree, appended so id references resolve against the real
 *  document (accname needs that), and removed afterwards. */
function withDom<T>(html: string, run: (root: HTMLElement) => T): T {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  try {
    return run(host)
  } finally {
    host.remove()
  }
}

// ── The adversarial pass's repros ───────────────────────────────────────────
//
// Each of these is a route by which a live control value reached an accessible
// name, and from there `typedInto.hit`, every `StampTarget`, the fingerprint,
// the snapshot and the PERSISTED evidence. They are grouped because they share
// one lesson: a check scoped to "the label sources I thought of" is a check that
// gets bypassed by the next reference mechanism nobody enumerated.

describe('the adversarial repros — no reference mechanism carries a value', () => {
  it('aria-owns re-parents a filled control into a name', () => {
    const secret = 'SECRET-OWNS-4242424242424242'
    withDom(`<button id="ao-btn" aria-owns="ao-card">Pay</button><input id="ao-card" type="text">`, () => {
      ;(document.getElementById('ao-card') as HTMLInputElement).value = secret
      const name = nameOf(document.getElementById('ao-btn')!)
      expect(name).not.toContain(secret)
      expect(name).toContain('Pay')
    })
  })

  // One case per role rather than a loop: the value index is a per-TASK memo
  // (page script cannot change a value while a walk holds the stack, so it is
  // invalidated exactly when it could go stale), and rebuilding the DOM three
  // times inside one synchronous test is a thing only a test can do. Separate
  // cases keep the assertion about the fix rather than about the memo.
  it.each(['row', 'treeitem', 'combobox'])('aria-owns re-parenting under role=%s', (role) => {
    const secret = `SECRET-OWNS-${role.toUpperCase()}-9999`
    withDom(`<div id="ao-r" role="${role}" aria-owns="ao-f">Item</div><input id="ao-f" type="text">`, () => {
      ;(document.getElementById('ao-f') as HTMLInputElement).value = secret
      expect(nameOf(document.getElementById('ao-r')!)).not.toContain(secret)
    })
  })

  it('a DESCENDANT’s aria-labelledby reaches an unlabelled control', () => {
    const secret = 'SECRET-DESC-LABELLEDBY-private-key'
    withDom(
      `<div id="dl-btn" role="button">Edit <span aria-labelledby="dl-note"></span></div><textarea id="dl-note"></textarea>`,
      () => {
        ;(document.getElementById('dl-note') as HTMLTextAreaElement).value = secret
        ;(document.getElementById('dl-note') as HTMLTextAreaElement).textContent = secret
        expect(nameOf(document.getElementById('dl-btn')!)).not.toContain(secret)
      },
    )
  })

  it('MORE labelledby ids than the scan bound — the bound must fail CLOSED', () => {
    const secret = 'SECRET-NINTH-ID-overflow'
    const ids = Array.from({ length: 9 }, (_, i) => `ov-${i}`)
    const spans = ids
      .slice(0, 8)
      .map((id) => `<span id="${id}">w${id}</span>`)
      .join('')
    withDom(`<button id="ov-btn" aria-labelledby="${ids.join(' ')}">x</button>${spans}<input id="ov-8" type="text">`, () => {
      ;(document.getElementById('ov-8') as HTMLInputElement).value = secret
      expect(nameOf(document.getElementById('ov-btn')!)).not.toContain(secret)
    })
  })

  it('MORE filled controls than the value budget — the budget must fail CLOSED', () => {
    const secret = 'SECRET-PAST-THE-BUDGET-token'
    const decoys = Array.from({ length: 40 }, (_, i) => `<input id="bd-${i}" type="text" aria-hidden="true">`).join('')
    withDom(`${decoys}<div id="bd-btn" role="button">Total <input id="bd-real" type="text"></div>`, () => {
      for (let i = 0; i < 40; i++) (document.getElementById(`bd-${i}`) as HTMLInputElement).value = `decoy-${i}-filler`
      ;(document.getElementById('bd-real') as HTMLInputElement).value = secret
      expect(nameOf(document.getElementById('bd-btn')!)).not.toContain(secret)
    })
  })

  // ── Round two: what a value-MATCHING check misses, and what it breaks ──────
  //
  // These three are one lesson. Comparing a computed name against serialized
  // values is matching a SERIALIZATION, so it is always one re-serialization
  // away from a miss — and doing it page-wide is a name eraser. Removing the
  // control from the computation instead leaves nothing to match.

  it('a SELECT’s selected OPTION TEXT, which is not its value', () => {
    // accname answers a combobox with the selected option's visible TEXT; an
    // index holding `select.value` holds the option's VALUE ATTRIBUTE. Two
    // different strings, so the substring compare never fires.
    const secret = 'SECRET-OPTION-Dr-Ravi-Patel'
    withDom(
      `<div id="so-btn" role="button">Doctor <select id="so-sel"><option value="opt-a">Other</option><option value="opt-b">${secret}</option></select></div>`,
      () => {
        ;(document.getElementById('so-sel') as HTMLSelectElement).value = 'opt-b'
        const name = nameOf(document.getElementById('so-btn')!)
        expect(name).not.toContain(secret)
        expect(name).toContain('Doctor')
      },
    )
  })

  it('a contenteditable with BLOCK children, whose text serializes differently', () => {
    // accname joins block children with spaces; `textContent` does not. The same
    // characters on ONE line were caught and across two were not — the proof
    // that the check was matching a serialization rather than a value.
    withDom(`<div id="ce-btn" role="button">Card <div id="ce" contenteditable="true"></div></div>`, () => {
      const editable = document.getElementById('ce')!
      editable.innerHTML = `<div>4111 1111</div><div>-2222</div>`
      const name = nameOf(document.getElementById('ce-btn')!)
      expect(name).not.toContain('4111')
      expect(name).not.toContain('2222')
      expect(name).toContain('Card')
    })
  })

  it('does NOT erase unrelated names — one character in a search box blanks nothing', () => {
    // The regression a page-wide substring check causes, and it is this
    // pipeline's most expensive recurring bug: a fingerprint's `name` is
    // compared for EXACT EQUALITY against a freshly computed one when a note
    // re-anchors, so a name that empties out reads to the user as "this element
    // is gone" for an element sitting right in front of them.
    withDom(`<input id="er-search" type="text"><button id="er-btn">Checkout</button><h1 id="er-h">Delivery</h1>`, () => {
      const search = document.getElementById('er-search') as HTMLInputElement
      search.value = 'e'
      expect(nameOf(document.getElementById('er-btn')!)).toBe('Checkout')
      expect(nameOf(document.getElementById('er-h')!)).toBe('Delivery')
      // And a whole-word collision, which is the plausible one.
      search.value = 'Checkout'
      expect(nameOf(document.getElementById('er-btn')!)).toBe('Checkout')
    })
  })

  it('treats a document in designMode as editable throughout', () => {
    withDom(`<div id="dm-btn" role="button"></div>`, () => {
      const el = document.getElementById('dm-btn')!
      el.textContent = 'SECRET-DESIGNMODE-typed-here'
      document.designMode = 'on'
      try {
        expect(nameOf(el)).not.toContain('SECRET-DESIGNMODE')
      } finally {
        document.designMode = 'off'
      }
    })
  })

  // ── Round three: what the clone BROKE, and what it still cannot see ────────

  it.each(['dialog', 'navigation', 'region', 'button', 'combobox', 'tab', 'treeitem'])(
    'KEEPS the name of a role=%s named by aria-labelledby',
    (role) => {
      // The regression the clone introduced. accname resolves an id reference
      // through `node.getRootNode().getElementById(id)`, and a DETACHED clone's
      // root is an Element with no such method — so every reference-named
      // element came back nameless and `fingerprintOf` minted `name: ""` for
      // each. An empty name is not a cosmetic loss: it is compared for exact
      // equality when a note re-anchors.
      withDom(`<h2 id="rl-t">Delete file?</h2><div id="rl-el" role="${role}" aria-labelledby="rl-t"></div>`, () => {
        expect(nameOf(document.getElementById('rl-el')!)).toBe('Delete file?')
      })
    },
  )

  it('a labelledby target that is a FILLED control still leaks nothing', () => {
    // The other half of that fix: restoring the name must not restore the leak.
    // `safeNameFor` resolves the reference against the LIVE root with controls
    // stripped, so a label made of a filled field contributes nothing.
    const secret = 'SECRET-LABELLEDBY-TARGET-4444'
    withDom(
      `<div id="lt-wrap">Card <input id="lt-in" type="text"></div><button id="lt-b" aria-labelledby="lt-wrap"></button>`,
      () => {
        ;(document.getElementById('lt-in') as HTMLInputElement).value = secret
        const name = nameOf(document.getElementById('lt-b')!)
        expect(name).not.toContain(secret)
        expect(name).toContain('Card')
      },
    )
    withDom(`<input id="lt2-in" type="text"><button id="lt2-b" aria-labelledby="lt2-in"></button>`, () => {
      ;(document.getElementById('lt2-in') as HTMLInputElement).value = secret
      expect(nameOf(document.getElementById('lt2-b')!)).not.toContain(secret)
    })
  })

  it('a SLOT’s assigned light-DOM control', () => {
    // `querySelector` cannot see slot-assigned nodes, so the pre-check answered
    // "no control here" and accname — which DOES flatten `assignedNodes()` —
    // named the button with the slotted field's live value.
    const secret = 'SECRET-SLOTTED-7777888899990000'
    const host = document.createElement('x-card')
    host.innerHTML = `<input id="sl-in" type="text">`
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<div id="sl-btn" role="button">Total <slot></slot></div>`
    document.body.appendChild(host)
    try {
      ;(document.getElementById('sl-in') as HTMLInputElement).value = secret
      const name = nameOf(shadow.getElementById('sl-btn')!)
      expect(name).not.toContain(secret)
      expect(name).toContain('Total')
    } finally {
      host.remove()
    }
  })

  // ── Round four: a control's own BODY must never name another element ──────

  const NAMED_ROLES = ['dialog', 'navigation', 'region', 'button', 'combobox', 'tab', 'treeitem']

  it.each(NAMED_ROLES)('a labelledby CONTENTEDITABLE past the name cap cannot name a role=%s', (role) => {
    // The squash-then-check ceiling: the candidate name is cut to 80 before the
    // containment check runs while the value is the full 97 characters, and a
    // needle longer than the haystack never matches — so the first 79 characters
    // shipped. A string match cannot be the only defence when the candidate name
    // IS the target's own typed body.
    const secret = `SECRET-LONG-${'x'.repeat(85)}`
    withDom(
      `<div id="lc-lbl" contenteditable="true">${secret}</div><div id="lc-el" role="${role}" aria-labelledby="lc-lbl"></div>`,
      () => {
        expect(nameOf(document.getElementById('lc-el')!)).not.toContain('SECRET-LONG-')
      },
    )
  })

  it('a labelledby CONTENTEDITABLE beside a plain label — where equality cannot save us', () => {
    // The case that proves the refusal has to be STRUCTURAL. With two ids the
    // rebuilt name is "<typed body> Details", which is not EQUAL to the value,
    // so an equality check passes it; and a containment check cannot be used
    // here without blanking legitimate labels. The only thing that works is for
    // the control target to contribute nothing in the first place.
    const secret = 'SECRET-PAIRED-LABEL-passphrase'
    withDom(
      `<div id="pl-a" contenteditable="true">${secret}</div><span id="pl-b">Details</span>` +
        `<div id="pl-el" role="dialog" aria-labelledby="pl-a pl-b"></div>`,
      () => {
        const name = nameOf(document.getElementById('pl-el')!)
        expect(name).not.toContain('SECRET-PAIRED-LABEL')
        // …and the non-control half of the label still names it.
        expect(name).toBe('Details')
      },
    )
  })

  it('a labelledby CONTENTEDITABLE cannot name a control either (branch a)', () => {
    const secret = `SECRET-LONG-${'x'.repeat(85)}`
    withDom(`<div id="lb-lbl" contenteditable="true">${secret}</div><input id="lb-in" type="text" aria-labelledby="lb-lbl">`, () => {
      expect(nameOf(document.getElementById('lb-in')!)).not.toContain('SECRET-LONG-')
    })
  })

  it('a labelledby TEXTAREA cannot name anything — its body is the user’s', () => {
    // A textarea holds its value as a child text node, so the target's own
    // default body is text the user typed.
    const secret = 'SECRET-TEXTAREA-BODY-my-passphrase'
    withDom(`<textarea id="ta-lbl">${secret}</textarea><div id="ta-el" role="dialog" aria-labelledby="ta-lbl"></div>`, () => {
      expect(nameOf(document.getElementById('ta-el')!)).not.toContain(secret)
    })
  })

  it('the ABANDONED-CLONE escape hatch is guarded too', () => {
    // Past MAX_REFERRERS the clone is given up — reachable on an ordinary long
    // form, with no hostile intent — and that path returned `safeNameFor`
    // unchecked.
    const secret = 'SECRET-ABANDONED-CLONE-passphrase'
    const many = Array.from({ length: 65 }, (_, i) => `<span id="ab-s${i}" aria-labelledby="ab-s${i}">w${i}</span>`).join('')
    withDom(
      `<div id="ab-lbl" contenteditable="true">${secret}</div><div id="ab-el" role="dialog" aria-labelledby="ab-lbl">${many}</div>`,
      () => {
        expect(nameOf(document.getElementById('ab-el')!)).not.toContain(secret)
      },
    )
  })

  it('does NOT blank a legitimate label because the user typed one of its words', () => {
    // The re-anchoring break. The label text is control-free, but it can still
    // CONTAIN a word the user typed into a control living inside the label
    // source — and discarding a control-free name on that basis is the "present
    // element reads needs-re-pointing" bug: `fingerprintOf` stored "Edit
    // profile", and `resolveAnchors` compares it for exact equality.
    withDom(
      `<h2 id="st-lbl">Edit <input id="st-q" type="text"> profile</h2><div id="st-el" role="dialog" aria-labelledby="st-lbl"></div>`,
      () => {
        expect(nameOf(document.getElementById('st-el')!)).toBe('Edit profile')
        const q = document.getElementById('st-q') as HTMLInputElement
        q.value = 'Edit'
        expect(nameOf(document.getElementById('st-el')!)).toBe('Edit profile')
        q.value = 'profile'
        expect(nameOf(document.getElementById('st-el')!)).toBe('Edit profile')
      },
    )
  })

  it.each(['inherit', 'junk'])('contenteditable="%s" outside an editable region is NOT editable', (value) => {
    // Per HTML the invalid-value default is *inherit*, so an unrecognised
    // keyword must keep the walk climbing rather than terminating it as
    // editable — otherwise a wrapper carrying one blanks every name beneath it.
    withDom(`<div contenteditable="${value}"><button id="ce-b">Checkout</button><h1 id="ce-h">Delivery</h1></div>`, () => {
      expect(nameOf(document.getElementById('ce-b')!)).toBe('Checkout')
      expect(nameOf(document.getElementById('ce-h')!)).toBe('Delivery')
    })
  })

  it('keeps NON-control slotted text while withholding the slotted control', () => {
    const secret = 'SECRET-SLOTTED-KEEP-1234567890'
    const host = document.createElement('x-total')
    host.innerHTML = `<span>Order total</span><input id="sk-in" type="text">`
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<div id="sk-btn" role="button">Total <slot></slot></div>`
    document.body.appendChild(host)
    try {
      ;(document.getElementById('sk-in') as HTMLInputElement).value = secret
      const name = nameOf(shadow.getElementById('sk-btn')!)
      expect(name).not.toContain(secret)
      expect(name).toContain('Total')
      // The legitimate slotted text survives: deleting the slot wholesale lost
      // it, and a slot-only element went completely nameless.
      expect(name).toContain('Order total')
    } finally {
      host.remove()
    }
  })

  // ── Round five: the slot that is ITSELF the subject ───────────────────────

  /** A component whose SHADOW markup is the given html, with `light` assigned. */
  function withSlotHost<T>(shadowHtml: string, light: string, run: (shadow: ShadowRoot) => T): T {
    const host = document.createElement('x-subject')
    host.innerHTML = light
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = shadowHtml
    document.body.appendChild(host)
    try {
      return run(shadow)
    } finally {
      host.remove()
    }
  }

  it.each([
    ['input', `<input id="sa-c" type="text">`],
    ['textarea', `<textarea id="sa-c"></textarea>`],
    ['contenteditable', `<div id="sa-c" contenteditable="true"></div>`],
    ['a nested wrapper control', `<div><span>Total</span><input id="sa-c" type="text"></div>`],
  ])('a SLOT that is itself the named subject withholds an assigned %s', (_kind, light) => {
    // Every slot helper asked `el.querySelectorAll('slot')`, which never matches
    // the element ITSELF — so the pre-check answered "no control here", accname
    // ran on the live element and took its `getSlotContents` branch, and the
    // containment backstop could not help either: it is scoped to REFERENCED
    // controls and this one is ASSIGNED. Uncapped, and it reaches the snapshot
    // and the fingerprint.
    const secret = 'SECRET-SLOT-SUBJECT-4242424242424242'
    withSlotHost(`<slot id="sa-s" role="button">Fallback</slot>`, light, (shadow) => {
      const control = document.getElementById('sa-c')!
      if (control.tagName.toLowerCase() === 'div') control.textContent = secret
      else (control as HTMLInputElement).value = secret
      expect(nameOf(shadow.getElementById('sa-s')!)).not.toContain('SECRET-SLOT-SUBJECT')
    })
  })

  it('a SLOT that is itself the subject still names from NON-control assigned text', () => {
    // The faithful half: a slot renders its assigned nodes, so that is what
    // should name it — minus the controls, not minus everything.
    withSlotHost(`<slot id="sn-s" role="button">Fallback</slot>`, `<span>Order total</span>`, (shadow) => {
      expect(nameOf(shadow.getElementById('sn-s')!)).toContain('Order total')
    })
  })

  it('a SLOT that is itself the subject keeps its non-control assigned text BESIDE a control', () => {
    // The faithful half, and the only shape that exercises it: with a control
    // assigned the clone path is taken, so the root slot has to be EXPANDED into
    // what it renders rather than left as its fallback. Without the expansion
    // this names "Fallback" — markup the user never saw — and with a wholesale
    // slot delete it names nothing at all.
    const secret = 'SECRET-SLOT-MIXED-9999000011112222'
    withSlotHost(`<slot id="sm-s" role="button">Fallback</slot>`, `<span>Order total</span><input id="sm-c" type="text">`, (shadow) => {
      ;(document.getElementById('sm-c') as HTMLInputElement).value = secret
      const name = nameOf(shadow.getElementById('sm-s')!)
      expect(name).not.toContain('SECRET-SLOT-MIXED')
      expect(name).toBe('Order total')
    })
  })

  it('a SLOT with nothing assigned still names from its FALLBACK', () => {
    withSlotHost(`<slot id="sf-s" role="button">Fallback</slot>`, ``, (shadow) => {
      expect(nameOf(shadow.getElementById('sf-s')!)).toBe('Fallback')
    })
  })

  // ── Round six: ONE decision, applied everywhere, every bound fail-closed ──
  //
  // Three more variants of one class: a pre-check that used CONTROL_SELECTOR
  // where RISKY_SELECTOR was meant, a cap that returned false, and a family of
  // value-bearing ARIA roles nobody had listed. They are grouped because the fix
  // is one rule, not three patches.

  it('a slot-assigned node that REFERENCES a control (risky ≠ control)', () => {
    // The assigned node is not a control; it points at one. A pre-check that
    // asks "is this a control" answers no, and accname follows the reference.
    const secret = 'SECRET-SLOT-REF-5555666677778888'
    withSlotHost(
      `<slot id="sr-s" role="button">Fallback</slot>`,
      `<span aria-labelledby="sr-live">x</span><input id="sr-live" type="text">`,
      (shadow) => {
        ;(document.getElementById('sr-live') as HTMLInputElement).value = secret
        expect(nameOf(shadow.getElementById('sr-s')!)).not.toContain('SECRET-SLOT-REF')
      },
    )
  })

  it('a control PAST the slot scan cap — the bound must fail CLOSED', () => {
    // Positioned past MAX_SLOT_SCAN deliberately, and off the exported constant
    // rather than a literal: the first version of this test used 100 slots
    // against a cap that had been raised to 256, so it never reached the
    // truncation branch and passed with the fail-closed return mutated away.
    const secret = 'SECRET-SLOT-CAP-1212121212121212'
    const beyond = MAX_SLOT_SCAN + 40
    const slots = Array.from({ length: beyond }, (_, i) => `<slot name="sc${i}"></slot>`).join('')
    withSlotHost(
      `<div id="sc-w" role="button">Total ${slots}</div>`,
      `<input id="sc-in" slot="sc${beyond - 5}" type="text">`,
      (shadow) => {
        ;(document.getElementById('sc-in') as HTMLInputElement).value = secret
        expect(nameOf(shadow.getElementById('sc-w')!)).not.toContain('SECRET-SLOT-CAP')
      },
    )
  })

  it('a slot-assigned node that is RISKY but not a typed control', () => {
    // The slot scan asked "is this a control the user types into". A
    // `role="listbox"` is neither that nor a `contenteditable`, and its selected
    // option is still the user's answer — so the scan has to ask the RISKY
    // question, which is strictly wider.
    const secret = 'SECRET-SLOT-LISTBOX-Enterprise'
    withSlotHost(
      `<slot id="sl2-s" role="button">Fallback</slot>`,
      `<div role="listbox"><div role="option" aria-selected="true">${secret}</div></div>`,
      (shadow) => {
        expect(nameOf(shadow.getElementById('sl2-s')!)).not.toContain('SECRET-SLOT-LISTBOX')
      },
    )
  })

  it.each([
    ['textbox', `<div id="dr-c" role="textbox">SECRET-ARIA-ROLE-value</div>`],
    ['searchbox', `<div id="dr-c" role="searchbox">SECRET-ARIA-ROLE-value</div>`],
    ['combobox', `<div id="dr-c" role="combobox">SECRET-ARIA-ROLE-value</div>`],
    ['spinbutton', `<div id="dr-c" role="spinbutton" aria-valuenow="42" aria-valuetext="SECRET-ARIA-ROLE-value"></div>`],
    ['slider', `<div id="dr-c" role="slider" aria-valuenow="7" aria-valuetext="SECRET-ARIA-ROLE-value"></div>`],
  ])('a DECLARED-editable role=%s inside a named element withholds its value', (_role, markup) => {
    // accname step 2E reads a textbox's text as its value, and the ARIA roles
    // that declare "this holds the user's answer" were on no list here.
    withDom(`<div id="dr-w" role="button">Note ${markup}</div>`, () => {
      const name = nameOf(document.getElementById('dr-w')!)
      expect(name).not.toContain('SECRET-ARIA-ROLE')
      expect(name).toContain('Note')
    })
  })

  it('an aria-valuetext on a role this file never listed', () => {
    // `role="progressbar"` is not on any list here, and accname reads its
    // `aria-valuetext` into the parent's name regardless — measured. The
    // ATTRIBUTE tokens in CONTROL_SELECTOR are what catch it, which is the point
    // of listing attributes as well as roles: the roles are the ones somebody
    // thought of.
    //
    // It costs page-authored progress text ("Note 42% complete" reads "Note"),
    // and that is the same trade every rule in this file makes: a missing word
    // against a value that must not leave.
    withDom(`<div id="pv-w" role="button">Note <div role="progressbar" aria-valuetext="SECRET-VALUETEXT-42"></div></div>`, () => {
      const name = nameOf(document.getElementById('pv-w')!)
      expect(name).not.toContain('SECRET-VALUETEXT')
      expect(name).toContain('Note')
    })
  })

  it('a range widget VALUE (progress/meter/scrollbar) does not become a name', () => {
    // The gap the aria-valuetext case above does not cover: accname's range
    // branch reads getAttribute("value") too, and `progress.value =` reflects
    // into the attribute, so a live script-driven value (a password meter, a
    // score, an upload) leaks. The value WINS over the element's own text, so
    // this is accname's value channel, not content. Caught by the role token AND
    // the native tag, so the tag cannot dodge the role.
    for (const markup of [
      '<progress id="rv" value="SECRET-PROGRESS-4242">70% done</progress>',
      '<meter id="rv" value="0.9">SECRET-METER-9</meter>',
      '<div id="rv" role="progressbar" value="SECRET-ROLE-VAL"></div>',
      '<div id="rv" role="scrollbar" aria-valuenow="88" value="SECRET-SCROLL"></div>',
    ]) {
      withDom(`<div id="rv-w" role="button">Upload ${markup}</div>`, () => {
        const name = nameOf(document.getElementById('rv-w')!)
        expect(name).not.toContain('SECRET')
        expect(name).toContain('Upload')
      })
    }
  })

  it('a STANDALONE declared-editable role withholds its own text too', () => {
    withDom(`<div id="ds-c" role="textbox">SECRET-STANDALONE-passphrase</div>`, () => {
      expect(nameOf(document.getElementById('ds-c')!)).not.toContain('SECRET-STANDALONE')
    })
  })

  it('an ARIA listbox withholds its selected option exactly as a native select does', () => {
    // The module's committed policy is that the SELECTED value is the user's
    // answer. The ARIA equivalent has to match it, or the policy is a statement
    // about one spelling of a widget.
    const secret = 'SECRET-SELECTED-Enterprise-Plan'
    withDom(
      `<div id="lb-w" role="button">Plan <div role="listbox"><div role="option" aria-selected="true">${secret}</div></div></div>` +
        `<div id="sel-w" role="button">Plan <select><option value="a" selected>${secret}</option></select></div>`,
      () => {
        expect(nameOf(document.getElementById('lb-w')!)).not.toContain('SECRET-SELECTED')
        expect(nameOf(document.getElementById('sel-w')!)).not.toContain('SECRET-SELECTED')
      },
    )
  })

  it('keeps BARE TEXT assigned to a slot — accname reads nodes, not only elements', () => {
    // `assignedElements()` drops text nodes while accname's `assignedNodes()`
    // keeps them, so a slot filled with bare text named from its fallback —
    // markup the user never saw.
    withSlotHost(`<slot id="bt-s" role="button">Fallback</slot>`, `Order total<input id="bt-in" type="text">`, (shadow) => {
      ;(document.getElementById('bt-in') as HTMLInputElement).value = 'SECRET-BARE-TEXT-9999'
      const name = nameOf(shadow.getElementById('bt-s')!)
      expect(name).not.toContain('SECRET-BARE-TEXT')
      expect(name).toContain('Order total')
    })
  })

  it.each(['  ', '\t', '\n'])('whitespace-only contenteditable=%j is NOT editable', (value) => {
    // Per HTML only a literal empty value, `true` or `plaintext-only` is
    // editable; whitespace is an invalid keyword, and the invalid-value default
    // is *inherit*. Trimming before the match read `"  "` as the empty-string
    // keyword and blanked the whole subtree's names.
    withDom(`<div contenteditable="${value}"><button id="ws-b">Checkout</button><h1 id="ws-h">Delivery</h1></div>`, () => {
      expect(nameOf(document.getElementById('ws-b')!)).toBe('Checkout')
      expect(nameOf(document.getElementById('ws-h')!)).toBe('Delivery')
    })
  })

  it('a literal contenteditable="" IS editable', () => {
    withDom(`<div id="es-root" contenteditable=""><div id="es-line">SECRET-EMPTY-KEYWORD-typed</div></div>`, () => {
      expect(nameOf(document.getElementById('es-line')!)).not.toContain('SECRET-EMPTY-KEYWORD')
    })
  })

  it('a BLOCK CHILD of a contenteditable — editability INHERITS', () => {
    // `holdsTypedText` asked whether the element ITSELF carried the attribute,
    // so the parent was correctly blank while every typed line inside it was
    // named with its own text.
    withDom(`<div id="ci-root" contenteditable="true"><div id="ci-line">SECRET-LINE-my-passphrase</div></div>`, () => {
      expect(nameOf(document.getElementById('ci-line')!)).not.toContain('SECRET-LINE')
      expect(nameOf(document.getElementById('ci-root')!)).not.toContain('SECRET-LINE')
    })
    // An explicit `contenteditable="false"` island inside one is NOT editable,
    // so its own text is the page's again.
    withDom(`<div contenteditable="true"><div id="ci-off" contenteditable="false">Read only</div></div>`, () => {
      expect(nameOf(document.getElementById('ci-off')!)).toBe('Read only')
    })
  })
})

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

  it('RECORDS the limit: ANY runtime value write on a button is page-authored laundering', () => {
    // Measured, not assumed, and NO TYPE FLIP IS REQUIRED — the earlier claim
    // that the attribute was immune to runtime assignment was simply wrong. A
    // button-family input's API value mode is "default", so `.value = x`
    // reflects straight into the content attribute and `getAttribute` reads it
    // back. A page that assigns `payButton.value = card.value` gets that string
    // named.
    //
    // The bound is why it is tolerable rather than closed: the string is PAINTED
    // ON THE BUTTON, so nothing reaches the agent that the user cannot see on
    // their own screen. It is the page-authored laundering the module header
    // declares a non-goal — a page able to do it could equally assign
    // `aria-label = field.value`. Pinned so the boundary is a recorded fact.
    const button = document.createElement('input')
    button.type = 'submit'
    button.setAttribute('value', 'Pay now')
    document.body.appendChild(button)
    expect(nameOf(button)).toBe('Pay now')
    button.value = 'LAUNDERED-by-the-page'
    expect(button.getAttribute('value')).toBe('LAUNDERED-by-the-page')
    expect(nameOf(button)).toBe('LAUNDERED-by-the-page')
    button.remove()

    // The same write on a TEXT field reaches no name at all: the type gate, not
    // the attribute, is what does the work.
    const typed = document.createElement('input')
    typed.type = 'text'
    document.body.appendChild(typed)
    typed.value = 'SECRET-TYPED-by-the-user'
    expect(nameOf(typed)).toBe('')
    typed.remove()
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

  it('not even the LENGTH, for a password field', async () => {
    // `valueLength` is deliberately carried for every other control — it is what
    // overflow and truncation review needs. A password is the one field where
    // the exact length is itself the secret's shape, and the page has already
    // told us it is one.
    const host = document.createElement('div')
    host.innerHTML = `<input id="pw" type="password" data-ux-id="pw">`
    document.body.appendChild(host)
    try {
      ;(document.getElementById('pw') as HTMLInputElement).value = 'correct-horse-battery'
      const result = await captureSnapshot({ analysis: false })
      const node = flatten(result.root).find((n) => n.uxId === 'pw')
      // Still visibly a password field that is present — only the count goes.
      expect(node?.state?.type).toBe('password')
      expect(node?.state?.valueLength).toBeUndefined()
    } finally {
      host.remove()
    }
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
