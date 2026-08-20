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

const { default: MultiAccountStatusline } = await import('../../../src/renderer/components/MultiAccountStatusline')

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
})

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

// Two-row footer (owner request): "if there are more than 3 open accounts the
// bottom bar stretches to two rows with a max of 3 accounts on each row - if the
// user has more than 6 then an overflow button they can click for their status".
describe('MultiAccountStatusline -- two-row footer + overflow', () => {
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

  it('3 accounts stay on ONE row', () => {
    useAccounts(3)
    render()
    expect(rows()).toHaveLength(1)
    expect(pills()).toHaveLength(3)
    expect(rows()[0].querySelectorAll('[data-testid="multi-account-pill"]')).toHaveLength(3)
    expect(toggle()).toBeNull()
  })

  it('the one-row layout keeps the tighter gap and no extra vertical padding, no truncation', () => {
    useAccounts(3)
    render()
    const strip = container.querySelector<HTMLElement>('[data-testid="multi-account-statusline"]')!
    expect(strip.className).not.toContain('py-1') // the bar does not grow
    // The boxed-pill design carries the visual boundary, so the inter-pill gap
    // tightened from gap-6 to gap-3. Split into gap-x/gap-y once rows could
    // wrap: the horizontal gap is unchanged, the row gap is the new part.
    expect(rows()[0].className).toContain('gap-x-3')
    expect(rows()[0].className).not.toContain('gap-6')
    // Pills keep their full width (email un-truncated) exactly as before.
    for (const p of pills()) {
      expect(p.className).toContain('shrink-0')
      expect(p.innerHTML).not.toContain('truncate')
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

  it('the two-row layout tightens the gap, pads the taller bar, and lets the email ellipsise', () => {
    useAccounts(4)
    render()
    const strip = container.querySelector<HTMLElement>('[data-testid="multi-account-statusline"]')!
    expect(strip.className).toContain('py-1')
    expect(rows()[0].className).toContain('gap-x-2')
    // Pills may shrink and the email ellipsises so three fit at the 1280px
    // minimum window width; the full address stays in the pill's title.
    for (const p of pills()) {
      expect(p.className).toContain('min-w-0')
      expect(p.innerHTML).toContain('truncate')
      expect(p.getAttribute('title')).toContain('@x.com')
    }
  })

  it('4 accounts stretch the strip to TWO rows', () => {
    useAccounts(4)
    render()
    const r = rows()
    expect(r).toHaveLength(2)
    expect(pills()).toHaveLength(4)
    expect(r.map((x) => x.querySelectorAll('[data-testid="multi-account-pill"]').length)).toEqual([2, 2])
    expect(toggle()).toBeNull()
  })

  it('6 accounts fill two rows of 3 with no overflow control', () => {
    useAccounts(6)
    render()
    const r = rows()
    expect(r).toHaveLength(2)
    expect(r.map((x) => x.querySelectorAll('[data-testid="multi-account-pill"]').length)).toEqual([3, 3])
    expect(pills()).toHaveLength(6)
    expect(toggle()).toBeNull()
  })

  it('7 accounts show SIX pills plus a "+1" overflow control', () => {
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

  it('9 accounts collapse three into the overflow control', () => {
    useAccounts(9)
    render()
    expect(pills()).toHaveLength(6)
    expect(toggle()!.textContent).toBe('+3')
  })

  it('clicking the overflow control reveals the hidden accounts, Escape dismisses it', () => {
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
    useAccounts(7)
    render()
    act(() => { toggle()!.click() })
    expect(popover()).toBeTruthy()
    act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(popover()).toBeNull()
  })

  it('a mousedown INSIDE the overflow popover keeps it open', () => {
    useAccounts(7)
    render()
    act(() => { toggle()!.click() })
    const pop = popover()!
    act(() => { pop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(popover()).toBeTruthy()
  })
})
