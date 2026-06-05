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
    { id: 'p2', accountEmail: 'nicholas.moger@example.com', name: '', createdAt: 0 },
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
      { id: '2', label: 'y', status: 'working', accountEmail: 'nicholas.moger@example.com', rateLimitCurrent: 55, rateLimitWeekly: 8 },
    ]
    act(() => { root.render(createElement(MultiAccountStatusline)) })

    // 2 accounts x (5h + 7d) = 4 progress bars.
    expect(container.querySelectorAll('[role="progressbar"]').length).toBe(4)
  })

  it('shows the FULL email un-truncated for each account', () => {
    sessionState.sessions = [
      { id: '1', label: 'x', status: 'working', accountEmail: 'a@x.com', rateLimitCurrent: 30, rateLimitWeekly: 12 },
      { id: '2', label: 'y', status: 'working', accountEmail: 'nicholas.moger@example.com', rateLimitCurrent: 55, rateLimitWeekly: 8 },
    ]
    act(() => { root.render(createElement(MultiAccountStatusline)) })

    const text = container.textContent ?? ''
    expect(text).toContain('a@x.com')
    expect(text).toContain('nicholas.moger@example.com') // full, not "nicholas.moger@..."

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
