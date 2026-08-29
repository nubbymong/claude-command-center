// @vitest-environment jsdom
// The bridge's TESTING-MODE reports (M3): `navigated` and `typedInto`, plus the
// `page` / `focusedRef` a state stamp is built from.
//
// Drives the BUNDLED bridge (see canvas-bridge-harness) — the same string
// ccc-ux:// serves — so nothing here can pass while the shipped script is
// broken.
//
// THE PROPERTY THIS FILE EXISTS TO PIN: these two events say what the user DID
// and never what they entered. `typedInto` fires on `input` from a real text
// field and carries the field's identity; the value is not in the event, is not
// derivable from it, and there is no rate at which the event becomes one.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { collectEvents, installBridge, stubLayout } from './canvas-bridge-harness'
import { captureSnapshot } from '../../../src/main/canvas/bridge/snapshot'
import type { SnapshotNode } from '../../../src/shared/canvas'

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

beforeAll(() => {
  stubLayout({ x: 10, y: 20, width: 100, height: 30 })
  document.body.innerHTML = `
    <main>
      <button data-ux-id="checkout-btn">Checkout</button>
      <input id="email" type="text" placeholder="you@example.com" />
      <label for="email">Email address</label>
      <textarea id="notes" aria-label="Delivery notes"></textarea>
    </main>`
  installBridge()
})

/** The bridge coalesces navigation reports, so a case has to start from a
 *  drained state or it inherits the previous one's pending timer. Each case gets
 *  its own route (so nothing it does looks like a no-op) and then waits out the
 *  coalescing window. */
let resetCount = 0
async function settleNavigation(): Promise<void> {
  window.history.replaceState({}, '', `/reset-${++resetCount}`)
  await new Promise((resolve) => setTimeout(resolve, 400))
}

beforeEach(async () => {
  await settleNavigation()
})

describe('navigated', () => {
  it('reports a hash change as pathname + hash, and NEVER the query string', async () => {
    const events = collectEvents('navigated', 500)
    window.history.replaceState({}, '', '/checkout?token=super-secret#step-2')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    const seen = await events
    expect(seen.length).toBeGreaterThan(0)
    const last = seen[seen.length - 1]
    expect(last.pathname).toBe('/checkout')
    expect(last.hash).toBe('#step-2')
    expect(JSON.stringify(last)).not.toContain('super-secret')
  })

  it('reports a pushState the page makes — the route change that fires no event of its own', async () => {
    const events = collectEvents('navigated', 500)
    window.history.pushState({}, '', '/basket')
    const seen = await events
    expect(seen.map((e) => e.pathname)).toContain('/basket')
  })

  it('returns the History method’s own result and leaves the navigation alone', () => {
    // The wrapper calls through: the URL moves, and pushState still answers
    // undefined as the platform does.
    const result = window.history.pushState({ step: 1 }, '', '/payment')
    expect(result).toBeUndefined()
    expect(window.location.pathname).toBe('/payment')
  })

  it('says nothing when the route has not actually moved', async () => {
    window.history.pushState({}, '', '/settled')
    // Drain the report that move earned, so what the window below sees is only
    // what the no-op produced.
    await collectEvents('navigated', 500)
    const events = collectEvents('navigated', 400)
    window.history.replaceState({}, '', '/settled')
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(await events).toHaveLength(0)
  })

  it('coalesces a burst rather than flooding the host', async () => {
    const events = collectEvents('navigated', 500)
    for (let i = 0; i < 40; i++) {
      window.history.pushState({}, '', `/loop-${i}`)
    }
    const seen = await events
    // Four a second is the ceiling; a 400 ms window cannot legitimately carry
    // more than a couple, and the run of 40 must not become 40 messages.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.length).toBeLessThanOrEqual(3)
  })
})

describe('typedInto', () => {
  it('reports the FIELD, once per focus session, and never the value', async () => {
    const email = document.getElementById('email') as HTMLInputElement
    const events = collectEvents('typedInto', 250)
    email.value = 'nick@example.com'
    email.dispatchEvent(new Event('input', { bubbles: true }))
    email.value = 'nick@example.com more'
    email.dispatchEvent(new Event('input', { bubbles: true }))
    const seen = await events
    expect(seen).toHaveLength(1)
    const hit = seen[0].hit as { role: string; name: string; tag: string }
    expect(hit.tag).toBe('input')
    expect(hit.name).toContain('Email')
    // The whole point, asserted on the serialized event rather than on a field
    // list: nothing in it carries what was typed.
    expect(JSON.stringify(seen[0])).not.toContain('nick@example.com')
  })

  it('reports again after the field is left and returned to', async () => {
    const email = document.getElementById('email') as HTMLInputElement
    const notes = document.getElementById('notes') as HTMLTextAreaElement
    // End whatever focus session the previous case left open, so the first
    // input below is genuinely the start of a new one.
    email.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
    const events = collectEvents('typedInto', 300)
    email.dispatchEvent(new Event('input', { bubbles: true }))
    email.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
    notes.dispatchEvent(new Event('input', { bubbles: true }))
    const seen = await events
    expect(seen).toHaveLength(2)
    expect((seen[0].hit as { tag: string }).tag).toBe('input')
    expect((seen[1].hit as { tag: string }).tag).toBe('textarea')
  })

  it('says nothing for an input event from a non-editable element', async () => {
    const button = document.querySelector('[data-ux-id="checkout-btn"]')!
    const events = collectEvents('typedInto', 200)
    button.dispatchEvent(new Event('input', { bubbles: true }))
    expect(await events).toHaveLength(0)
  })
})

describe('the snapshot carries where the page is and what has focus', () => {
  it('reports pathname, hash and title — and no query string', async () => {
    window.history.replaceState({}, '', '/checkout?session=abc123#top')
    document.title = 'Checkout'
    const result = await captureSnapshot({ analysis: false })
    expect(result.page).toEqual({ pathname: '/checkout', hash: '#top', title: 'Checkout' })
    expect(JSON.stringify(result.page)).not.toContain('abc123')
  })

  it('names the focused control by the ref of a node the tree actually emitted', async () => {
    const email = document.getElementById('email') as HTMLInputElement
    email.focus()
    const result = await captureSnapshot({ analysis: false })
    expect(result.focusedRef).toBeDefined()
    const node = flatten(result.root).find((n) => n.ref === result.focusedRef)
    expect(node?.name).toContain('Email')
    email.blur()
  })

  it('names nothing when the document itself holds focus', async () => {
    ;(document.getElementById('email') as HTMLInputElement).blur()
    document.body.focus()
    const result = await captureSnapshot({ analysis: false })
    expect(result.focusedRef).toBeUndefined()
  })
})
