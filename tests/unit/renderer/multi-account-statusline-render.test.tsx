// @vitest-environment jsdom
// Bug 3: the multi-account readout should use the real statusline progress BARS
// (5h/7d, like RateLimitBar) next to each account, and show the FULL email
// un-truncated -- not "5h X% · 7d Y%" text with a clipped email.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const sessionState: any = { sessions: [] }
const profilesState: any = { profiles: [] }
const settingsState: any = { settings: { accountAliases: {}, accountColourOverrides: {} } }

vi.mock('../../../src/renderer/stores/sessionStore', () => ({ useSessionStore: (sel: any) => sel(sessionState) }))
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({ useAccountProfilesStore: (sel: any) => sel(profilesState) }))
vi.mock('../../../src/renderer/stores/settingsStore', () => ({ useSettingsStore: (sel: any) => sel(settingsState) }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))

const { default: MultiAccountStatusline, FOOTER_PILL_GAP_PX } = await import('../../../src/renderer/components/MultiAccountStatusline')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  profilesState.profiles = [
    { id: 'p1', accountEmail: 'a@x.com', name: '', isPrimary: true, createdAt: 0 },
    { id: 'p2', accountEmail: 'jane.doe@example.com', name: '', createdAt: 0 },
  ]
  settingsState.settings = { accountAliases: {}, accountColourOverrides: {} }
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
  delete (globalThis as any).ResizeObserver
})

/**
 * jsdom does no layout: every getBoundingClientRect() is 0 x 0, which the
 * strip reads as "not measured yet" (one row, CSS wraps it). These tests
 * give it numbers instead -- a free width for the strip and a width per pill
 * -- so the row layout has something real to compute from (#378).
 */
let measured: { available: number; pill: number | ((email: string) => number) } | null = null
function measure(available: number, pill: number | ((email: string) => number)) {
  measured = { available, pill }
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    let width = 0
    if (measured) {
      const tid = this.getAttribute('data-testid')
      if (tid === 'multi-account-statusline') width = measured.available
      else if (tid === 'multi-account-pill') {
        const email = this.querySelector('[data-testid="multi-account-pill-label"]')?.textContent ?? ''
        width = typeof measured.pill === 'function' ? measured.pill(email) : measured.pill
      }
    }
    return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON() { return {} } } as DOMRect
  })
}

/** A ResizeObserver stand-in that lets a test fire the observer by hand. */
const roCallbacks: Array<() => void> = []
function installResizeObserver() {
  roCallbacks.length = 0
  ;(globalThis as any).ResizeObserver = class {
    private cb: () => void
    constructor(cb: () => void) { this.cb = cb; roCallbacks.push(cb) }
    observe() {}
    unobserve() {}
    disconnect() { const i = roCallbacks.indexOf(this.cb); if (i >= 0) roCallbacks.splice(i, 1) }
  }
}

describe('MultiAccountStatusline render (Bug 3)', () => {
  it('renders a 5h and 7d progress BAR per account (not percentage text)', () => {
    sessionState.sessions = [
      { id: '1', label: 'x', status: 'working', accountEmail: 'a@x.com', rateLimitCurrent: 30, rateLimitWeekly: 12 },
      { id: '2', label: 'y', status: 'working', accountEmail: 'jane.doe@example.com', rateLimitCurrent: 55, rateLimitWeekly: 8 },
    ]
    act(() => { root.render(createElement(MultiAccountStatusline)) })

    // 2 accounts x (5h + 7d) = 4 progress bars.
    expect(container.querySelectorAll('[role="progressbar"]').length).toBe(4)
  })

  it('shows the FULL email un-truncated for each account', () => {
    sessionState.sessions = [
      { id: '1', label: 'x', status: 'working', accountEmail: 'a@x.com', rateLimitCurrent: 30, rateLimitWeekly: 12 },
      { id: '2', label: 'y', status: 'working', accountEmail: 'jane.doe@example.com', rateLimitCurrent: 55, rateLimitWeekly: 8 },
    ]
    act(() => { root.render(createElement(MultiAccountStatusline)) })

    const text = container.textContent ?? ''
    expect(text).toContain('a@x.com')
    expect(text).toContain('jane.doe@example.com') // full, not "jane.doe@..."

    // No clipping classes on the email element.
    const root0 = container.firstChild as HTMLElement
    expect(root0.innerHTML).not.toContain('max-w-[120px]')
  })

  it('renders nothing for a single account', () => {
    sessionState.sessions = [
      { id: '1', label: 'x', status: 'working', accountEmail: 'a@x.com', rateLimitCurrent: 30, rateLimitWeekly: 12 },
    ]
    act(() => { root.render(createElement(MultiAccountStatusline)) })
    expect(container.firstChild).toBeNull()
  })
})

// Wrapping footer (owner request, #378): one row whenever every account pill
// fits in the free footer width; wrap only when they truly do not, filling
// each row before the next; at most two rows, the tail behind a "+N" overflow
// control. Rows come from MEASURED widths (see `measure` above), not a count.
describe('MultiAccountStatusline -- wrapping footer + overflow', () => {
  // n accounts, each with one live session and a 5h tick. Emails sort in the
  // order generated (name falls back to the email), so row contents are stable.
  function useAccounts(n: number): string[] {
    const emails = Array.from({ length: n }, (_, i) => `acct${i + 1}@x.com`)
    profilesState.profiles = emails.map((e, i) => ({ id: `p${i}`, accountEmail: e, name: '', isPrimary: i === 0, createdAt: 0 }))
    sessionState.sessions = emails.map((e, i) => ({
      id: String(i), label: 'x', status: 'working', accountEmail: e, rateLimitCurrent: 10 + i, rateLimitWeekly: 5,
    }))
    return emails
  }
  const render = () => act(() => { root.render(createElement(MultiAccountStatusline)) })
  const rows = () => Array.from(container.querySelectorAll('[data-testid="multi-account-row"]'))
  const pills = () => Array.from(container.querySelectorAll('[data-testid="multi-account-pill"]'))
  const toggle = () => container.querySelector<HTMLButtonElement>('[data-testid="multi-account-overflow-toggle"]')
  const popover = () => container.querySelector<HTMLElement>('[data-testid="multi-account-overflow-popover"]')

  const rowCounts = () => rows().map((x) => x.querySelectorAll('[data-testid="multi-account-pill"]').length)

  it('3 accounts stay on ONE row', () => {
    measure(1400, 300)
    useAccounts(3)
    render()
    expect(rows()).toHaveLength(1)
    expect(pills()).toHaveLength(3)
    expect(rowCounts()).toEqual([3])
    expect(toggle()).toBeNull()
  })

  it('#378: four pills of known width in a 1400px free span render on ONE row', () => {
    // The owner's case: four accounts, a 1900px window, the strip 2 x 2 with
    // empty footer either side. 4 x 300 + 3 x 12 = 1236 fits in 1400.
    measure(1400, 300)
    useAccounts(4)
    render()
    expect(rows()).toHaveLength(1)
    expect(rowCounts()).toEqual([4])
    expect(toggle()).toBeNull()
    const strip = container.querySelector<HTMLElement>('[data-testid="multi-account-statusline"]')!
    expect(strip.getAttribute('data-account-rows')).toBe('1')
  })

  it('#378: four pills that do NOT fit wrap fill-first (3 + 1), not balanced (2 + 2)', () => {
    // 3 x 300 + 2 x 12 = 924 fits in 1200; the fourth would make it 1236.
    measure(1200, 300)
    useAccounts(4)
    render()
    expect(rowCounts()).toEqual([3, 1])
    expect(toggle()).toBeNull()
  })

  it('#378: more than three fit on a row when the width is there', () => {
    measure(1400, 200) // 6 x 200 + 5 x 12 = 1260
    useAccounts(6)
    render()
    expect(rowCounts()).toEqual([6])
  })

  it('#378: the strip spans its centre zone so it measures the FREE width, not its own content', () => {
    // Shrink-to-fit (the old `flex flex-col items-center` with no width) would
    // measure the cluster itself -- useless for deciding how much room there is.
    useAccounts(2)
    render()
    const strip = container.querySelector<HTMLElement>('[data-testid="multi-account-statusline"]')!
    expect(strip.className).toContain('w-full')
    // Rows centre their pills inside it.
    expect(rows()[0].className).toContain('justify-center')
  })

  it('#378: re-lays out when the free width changes (ResizeObserver), without a remount', () => {
    installResizeObserver()
    measure(1400, 300)
    useAccounts(4)
    render()
    expect(rowCounts()).toEqual([4])
    expect(roCallbacks.length).toBeGreaterThan(0)
    // The window narrows: the same four pills no longer fit on one line.
    measured!.available = 1200
    act(() => { for (const cb of [...roCallbacks]) cb() })
    expect(rowCounts()).toEqual([3, 1])
    // ...and widens again: back to one row.
    measured!.available = 1400
    act(() => { for (const cb of [...roCallbacks]) cb() })
    expect(rowCounts()).toEqual([4])
  })

  it('#378: with nothing measured yet (first paint) everything is ONE row and nothing overflows', () => {
    // No `measure(...)`: jsdom's 0 x 0 rects are the pre-layout state. The
    // row is flex-wrap, so the browser wraps it until the effect has run.
    useAccounts(9)
    render()
    expect(rowCounts()).toEqual([9])
    expect(toggle()).toBeNull()
    expect(rows()[0].className).toContain('flex-wrap')
  })

  it('a footer pill carries NO identity dot — the rim and fill already say it', () => {
    // User call 2026-08-21: "we dont need the account colour dot as well as the
    // pill colour". Three statements of one fact, and the dot was the one
    // costing width in the tightest bar in the app.
    useAccounts(2)
    render()
    for (const pill of pills()) {
      // The dot was the only 8x8 round element inside a pill.
      expect(pill.querySelector('.w-2.h-2.rounded-full')).toBeNull()
    }
  })

  it('but the overflow list KEEPS its dots — there they are the only identity marking', () => {
    // Those rows carry no pill tint, so removing the dot there would leave
    // nothing at all tying a row to its account.
    // 1000px free, 300px pills: three per row, six on the two rows, so the
    // overflow control appears from the seventh account.
    measure(1000, 300)
    useAccounts(8)
    render()
    act(() => { toggle()!.click() })
    const overflowRows = Array.from(container.querySelectorAll('[data-testid="multi-account-overflow-row"]'))
    expect(overflowRows.length).toBeGreaterThan(0)
    for (const row of overflowRows) {
      expect(row.querySelector('.w-2.h-2.rounded-full')).not.toBeNull()
    }
  })

  it('the one-row layout adds no vertical padding and no truncation', () => {
    measure(1400, 300)
    useAccounts(3)
    render()
    const strip = container.querySelector<HTMLElement>('[data-testid="multi-account-statusline"]')!
    expect(strip.className).not.toContain('py-1') // the bar does not grow
    // Pills keep their full width (email un-truncated) exactly as before.
    for (const p of pills()) {
      expect(p.className).toContain('shrink-0')
      expect(p.innerHTML).not.toContain('truncate')
    }
  })

  it('#378: the pill gap is an inline px value equal to the layout constant, not a rem utility', () => {
    // The layout is computed with FOOTER_PILL_GAP_PX; the browser must lay
    // out with the same number. A `gap-x-*` class is rem-based and scales
    // with the global UI font size, so the two would drift apart.
    measure(1400, 300)
    useAccounts(4)
    render()
    for (const r of rows()) {
      expect(r.style.columnGap).toBe(`${FOOTER_PILL_GAP_PX}px`)
      expect(r.className).not.toMatch(/\bgap-x-/)
    }
  })

  it('wraps a row that does not fit rather than overflowing its zone', () => {
    // The occlusion bug: the count-split caps a row at 3 pills, but 3 pills
    // still exceed a narrow footer. The cluster is centred, so an over-wide row
    // spilled out of BOTH sides and the footer's overflow-hidden clipped the
    // leading pill against the CLI band. Wrapping is what makes the extra
    // accounts move to another line instead of being cut in half.
    useAccounts(3)
    render()
    for (const r of rows()) {
      expect(r.className).toContain('flex-wrap')
      // A row gap, so wrapped lines do not collide.
      expect(r.className).toContain('gap-y-1')
    }
  })

  it('shows waiting meters for an account whose statusline has not reported yet', () => {
    // A live account with no buckets is not an account with no usage -- it is
    // one whose detached statusline process has not written yet. Rendering no
    // meters at all reads as the former.
    sessionState.sessions = [
      { id: '1', label: 'x', status: 'working', accountEmail: 'a@x.com', rateLimitCurrent: 30, rateLimitWeekly: 12 },
      { id: '2', label: 'y', status: 'working', accountEmail: 'jane.doe@example.com' },
    ]
    render()

    const pending = container.querySelectorAll('[data-testid="rate-limit-pending"]')
    expect(pending.length).toBe(2) // 5h + Weekly for the un-reported account
    for (const p of pending) {
      expect(p.querySelector('.statusline-pending-track')).not.toBeNull()
      // Never a number: a placeholder must not read as a measurement.
      expect(p.textContent ?? '').not.toMatch(/\d+%/)
    }
    // The reporting account still shows real bars.
    expect(container.querySelectorAll('[role="progressbar"]').length).toBe(4)
  })

  it('shows NO waiting meters for an account that reported, but whose buckets the user hid', () => {
    // "Nothing shown" has two causes: nothing reported yet (wait), or the user
    // hid what was reported (their choice). Shimmering over the second
    // overrides the setting with an animation that can never resolve.
    //
    // The case has to be built carefully: hiding BOTH pending labels empties
    // the placeholder list anyway, so it would pass with or without the guard.
    // Here the account reports ONLY Fable and the user hides Fable, so `shown`
    // is empty while 5h/Weekly survive the placeholder filter -- which is
    // exactly when the two causes diverge.
    settingsState.settings = { ...settingsState.settings, footerHiddenUsageBuckets: ['Fable'] }
    sessionState.sessions = [
      { id: '1', label: 'x', status: 'working', accountEmail: 'a@x.com', rateLimitCurrent: 30, rateLimitWeekly: 12 },
      {
        id: '2',
        label: 'y',
        status: 'working',
        accountEmail: 'jane.doe@example.com',
        usageBuckets: [{ key: 'fable', label: 'Fable', group: 'model', percent: 61, resetsAt: '', severity: 'normal' }],
      },
    ]
    render()
    // It DID report. Hidden is a choice, not a wait.
    expect(container.querySelectorAll('[data-testid="rate-limit-pending"]').length).toBe(0)
  })

  it('the waiting meter is a bounded, indeterminate progressbar', () => {
    sessionState.sessions = [
      { id: '1', label: 'x', status: 'working', accountEmail: 'a@x.com', rateLimitCurrent: 30 },
      { id: '2', label: 'y', status: 'working', accountEmail: 'jane.doe@example.com' },
    ]
    render()
    const bar = container.querySelector('[data-testid="rate-limit-pending"] [role="progressbar"]')!
    expect(bar.getAttribute('aria-valuemin')).toBe('0')
    expect(bar.getAttribute('aria-valuemax')).toBe('100')
    // Indeterminate: no current value until one is reported.
    expect(bar.getAttribute('aria-valuenow')).toBeNull()
  })

  it('shows NO waiting meters when the status line is switched off', () => {
    // Nothing will ever arrive with the master switch off, so a shimmer there
    // never resolves -- worse than the blank it replaced.
    settingsState.settings = { ...settingsState.settings, statusLineEnabled: false }
    sessionState.sessions = [
      { id: '1', label: 'x', status: 'working', accountEmail: 'a@x.com', rateLimitCurrent: 30, rateLimitWeekly: 12 },
      { id: '2', label: 'y', status: 'working', accountEmail: 'jane.doe@example.com' },
    ]
    render()
    expect(container.querySelectorAll('[data-testid="rate-limit-pending"]').length).toBe(0)
  })

  it('every account sits in its own bounded pill (border + rounded), separating them structurally', () => {
    useAccounts(3)
    render()
    for (const p of pills()) {
      expect(p.className).toContain('rounded-full')
      expect(p.className).toContain('border')
      // A visible boundary, not whitespace alone.
      expect(p.getAttribute('style') ?? '').toContain('border-color')
    }
  })

  it('the two-row layout pads the taller bar and lets the email ellipsise', () => {
    measure(1200, 300) // 3 + 1
    useAccounts(4)
    render()
    const strip = container.querySelector<HTMLElement>('[data-testid="multi-account-statusline"]')!
    expect(strip.className).toContain('py-1')
    // Pills may shrink and the email ellipsises; the full address stays in
    // the pill's title.
    for (const p of pills()) {
      expect(p.className).toContain('min-w-0')
      expect(p.innerHTML).toContain('truncate')
      expect(p.getAttribute('title')).toContain('@x.com')
    }
  })

  it('4 accounts that do not fit stretch the strip to TWO rows', () => {
    measure(1200, 300)
    useAccounts(4)
    render()
    expect(rows()).toHaveLength(2)
    expect(pills()).toHaveLength(4)
    expect(toggle()).toBeNull()
  })

  it('6 accounts at three per row fill two rows of 3 with no overflow control', () => {
    measure(1000, 300)
    useAccounts(6)
    render()
    expect(rowCounts()).toEqual([3, 3])
    expect(pills()).toHaveLength(6)
    expect(toggle()).toBeNull()
  })

  it('7 accounts at three per row show SIX pills plus a "+1" overflow control', () => {
    measure(1000, 300)
    const emails = useAccounts(7)
    render()
    expect(rows()).toHaveLength(2)
    expect(pills()).toHaveLength(6)
    const btn = toggle()
    expect(btn).toBeTruthy()
    expect(btn!.textContent).toBe('+1')
    expect(btn!.getAttribute('aria-expanded')).toBe('false')
    expect(btn!.className).toContain('focus-ring') // keyboard focus is visible
    // The 7th account is NOT painted in the strip until the control is opened.
    expect(pills().map((p) => p.textContent).join(' ')).not.toContain(emails[6])
    // ...and it lives on the LAST row, so no row exceeds three accounts.
    expect(rows()[1].contains(btn!)).toBe(true)
  })

  it('9 accounts at three per row collapse three into the overflow control', () => {
    measure(1000, 300)
    useAccounts(9)
    render()
    expect(pills()).toHaveLength(6)
    expect(toggle()!.textContent).toBe('+3')
  })

  it('#378: the last row gives up a pill when the "+N" control would not fit beside it', () => {
    // 3 x 300 + 2 x 12 = 924 fits in 940, but + 12 + 40 for the control does
    // not: the second row keeps two pills and the control, the sixth account
    // joins the seventh behind it.
    measure(940, 300)
    useAccounts(7)
    render()
    expect(rowCounts()).toEqual([3, 2])
    expect(toggle()!.textContent).toBe('+2')
  })

  it('clicking the overflow control reveals the hidden accounts, Escape dismisses it', () => {
    measure(1000, 300)
    const emails = useAccounts(8)
    render()
    expect(popover()).toBeNull()

    act(() => { toggle()!.click() })
    const pop = popover()
    expect(pop).toBeTruthy()
    expect(pop!.getAttribute('role')).toBe('dialog')
    expect(toggle()!.getAttribute('aria-expanded')).toBe('true')
    // Both hidden accounts, with their usage meters, are in the popover.
    expect(pop!.textContent).toContain(emails[6])
    expect(pop!.textContent).toContain(emails[7])
    expect(pop!.querySelectorAll('[role="progressbar"]').length).toBe(4) // 2 accounts x (5h + Weekly)

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(popover()).toBeNull()
    expect(toggle()!.getAttribute('aria-expanded')).toBe('false')
  })

  it('a mousedown outside the overflow popover dismisses it', () => {
    measure(1000, 300)
    useAccounts(7)
    render()
    act(() => { toggle()!.click() })
    expect(popover()).toBeTruthy()
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(popover()).toBeNull()
  })

  it('a mousedown INSIDE the overflow popover keeps it open', () => {
    measure(1000, 300)
    useAccounts(7)
    render()
    act(() => { toggle()!.click() })
    const pop = popover()!
    act(() => { pop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(popover()).toBeTruthy()
  })
})
