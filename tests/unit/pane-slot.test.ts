// #439 — the pane-slot arbiter: at most ONE pane view attached to a window, so
// the ordinary (arbitrary-URL) browser view and the signed-in account view can
// never stack on one rectangle (the clickjack primitive the adversarial pass
// found). This is the CROSS-MODULE guarantee — two different view owners share
// the arbiter — so it is pinned on the arbiter directly.
import { describe, it, expect, beforeEach } from 'vitest'
import { attachPaneView, detachPaneView } from '../../src/main/pane-slot'

// Real Chromium APPENDS on addChildView (no dedupe); the arbiter's own
// early-return is what keeps a re-attach from duplicating, so the fake appends
// too — testing the arbiter, not a forgiving double.
function fakeWindow(id: number) {
  const children: unknown[] = []
  return {
    id,
    contentView: {
      children,
      addChildView: (v: unknown) => { children.push(v) },
      removeChildView: (v: unknown) => { const i = children.indexOf(v); if (i >= 0) children.splice(i, 1) },
    },
  }
}
const fakeView = (label: string) => ({ label, setBounds: () => {} })

let win: ReturnType<typeof fakeWindow>
beforeEach(() => { win = fakeWindow(1) })

describe('pane-slot arbiter', () => {
  it('attaching a second view (a DIFFERENT owner) detaches the first — never two at once', () => {
    const ordinary = fakeView('webview')
    const account = fakeView('account')
    attachPaneView(win as never, ordinary as never)
    expect(win.contentView.children).toEqual([ordinary])
    // The account view claims the same window: the ordinary view is evicted.
    attachPaneView(win as never, account as never)
    expect(win.contentView.children).toEqual([account])
    // And back the other way.
    attachPaneView(win as never, ordinary as never)
    expect(win.contentView.children).toEqual([ordinary])
  })

  it('re-attaching the current occupant is a no-op (no duplicate, no eviction of itself)', () => {
    const v = fakeView('v')
    attachPaneView(win as never, v as never)
    attachPaneView(win as never, v as never)
    expect(win.contentView.children).toEqual([v])
  })

  it('detach clears the slot only when it held that view', () => {
    const a = fakeView('a')
    const b = fakeView('b')
    attachPaneView(win as never, a as never)
    // Detaching a view the slot does not hold does not disturb the occupant.
    detachPaneView(win as never, b as never)
    attachPaneView(win as never, b as never) // evicts a
    expect(win.contentView.children).toEqual([b])
  })

  it('keeps windows independent (slot is per window id)', () => {
    const win2 = fakeWindow(2)
    const a = fakeView('a')
    const b = fakeView('b')
    attachPaneView(win as never, a as never)
    attachPaneView(win2 as never, b as never)
    // win2's attach must NOT have evicted win1's view.
    expect(win.contentView.children).toEqual([a])
    expect(win2.contentView.children).toEqual([b])
  })
})
