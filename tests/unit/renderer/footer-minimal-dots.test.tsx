// @vitest-environment jsdom
/**
 * Minimal mode for the multi-account footer: each account's meters collapse to
 * one traffic-light dot for usage and one per model bucket, and the label
 * becomes the account's NAME (friendly name when set, full email when not).
 *
 * The claims worth pinning, rather than the markup:
 *
 *  - the setting is opt-in, and an absent value means the meters, so no existing
 *    footer changes shape on upgrade;
 *  - "usage" is the WORST time window, not an average -- the strip answers "is
 *    anything about to run out", and averaging 5h 10% with Weekly 95% answers it
 *    wrongly;
 *  - the thresholds are RateLimitBar's own (peach at 70, red at 90), so a dot can
 *    never disagree with the bar the same data draws in the other mode;
 *  - a per-model bucket is told apart by the model segment of its KEY, because
 *    `group` is 'weekly' for both Weekly-all and Fable;
 *  - minimal mode obeys the SAME footer denylist, so hiding Fable drops its dot;
 *  - nothing reported yet is a neutral dot, never a green one -- green is a claim
 *    that the account has room, and nobody has measured it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const sessionState: any = { sessions: [] }
const profilesState: any = { profiles: [] }
const settingsState: any = { settings: {} }

vi.mock('../../../src/renderer/stores/sessionStore', () => ({ useSessionStore: (sel: any) => sel(sessionState) }))
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({ useAccountProfilesStore: (sel: any) => sel(profilesState) }))
vi.mock('../../../src/renderer/stores/settingsStore', () => ({ useSettingsStore: (sel: any) => sel(settingsState) }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))

const mod = await import('../../../src/renderer/components/MultiAccountStatusline')
const { default: MultiAccountStatusline, isModelBucket, ragFor, summariseAccountDots } = mod
import type { LiveAccount } from '../../../src/renderer/components/MultiAccountStatusline'
import type { UsageBucket } from '../../../src/shared/usage-types'

const bucket = (over: Partial<UsageBucket> & { label: string; percent: number }): UsageBucket => ({
  key: over.key ?? `${over.label}:`,
  group: over.group ?? 'weekly',
  resetsAt: over.resetsAt ?? '',
  severity: 'normal',
  ...over,
})

const account = (buckets: UsageBucket[], over: Partial<LiveAccount> = {}): LiveAccount => ({
  email: 'a@x.com', name: 'a@x.com', colourKey: 'mauve', buckets, count: 1, isPrimary: true, ...over,
})

/** Two live accounts, which is the gate the footer renders behind. */
const twoSessions = (extra: any = {}) => [
  { id: '1', label: 'x', status: 'working', accountEmail: 'a@x.com', ...extra },
  { id: '2', label: 'y', status: 'working', accountEmail: 'jane.doe@example.com', ...extra },
]

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
  settingsState.settings = { accountAliases: {}, accountColourOverrides: {}, footerAccountDisplay: 'dots' }
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const render = () => act(() => { root.render(createElement(MultiAccountStatusline)) })
const dots = () => container.querySelectorAll('[data-testid="account-usage-dot"]')

describe('isModelBucket -- group cannot decide it, the key can', () => {
  it('treats a per-model weekly as a model bucket even though its group is "weekly"', () => {
    expect(isModelBucket(bucket({ key: 'weekly:Fable', label: 'Fable', group: 'weekly', percent: 10 }))).toBe(true)
  })

  it('treats weekly-all as a time window despite the identical group', () => {
    expect(isModelBucket(bucket({ key: 'weekly_all:', label: 'Weekly', group: 'weekly', percent: 10 }))).toBe(false)
  })

  it('treats the 5h window as a time window', () => {
    expect(isModelBucket(bucket({ key: 'session:', label: '5h', group: 'session', percent: 10 }))).toBe(false)
  })

  it('treats the legacy colon-less keys as time windows', () => {
    expect(isModelBucket(bucket({ key: '5h', label: '5h', group: 'session', percent: 10 }))).toBe(false)
    expect(isModelBucket(bucket({ key: 'weekly', label: 'Weekly', group: 'weekly', percent: 10 }))).toBe(false)
  })
})

describe('ragFor -- the bars own the thresholds', () => {
  it('matches RateLimitBar exactly at every boundary', () => {
    expect(ragFor(0)).toBe('green')
    expect(ragFor(69)).toBe('green')
    expect(ragFor(70)).toBe('amber')   // the bar turns peach here
    expect(ragFor(89)).toBe('amber')
    expect(ragFor(90)).toBe('red')     // and red here
    expect(ragFor(100)).toBe('red')
  })
})

describe('summariseAccountDots', () => {
  const b5h = bucket({ key: 'session:', label: '5h', group: 'session', percent: 10 })
  const bWeek = bucket({ key: 'weekly_all:', label: 'Weekly', percent: 95 })
  const bFable = bucket({ key: 'weekly:Fable', label: 'Fable', percent: 30 })

  it('takes the WORST time window, not the average', () => {
    const s = summariseAccountDots(account([b5h, bWeek, bFable]), [])
    expect(s.usage!.worst.label).toBe('Weekly')
    expect(ragFor(s.usage!.worst.percent)).toBe('red')
  })

  it('keeps every model bucket as its own dot', () => {
    const s = summariseAccountDots(account([b5h, bWeek, bFable]), [])
    expect(s.models.map((m) => m.label)).toEqual(['Fable'])
  })

  it('honours the footer denylist -- hiding Fable drops its dot', () => {
    const s = summariseAccountDots(account([b5h, bWeek, bFable]), ['Fable'])
    expect(s.models).toEqual([])
    expect(s.usage!.worst.label).toBe('Weekly')
  })

  it('hiding Weekly leaves the usage dot tracking 5h alone', () => {
    const s = summariseAccountDots(account([b5h, bWeek, bFable]), ['Weekly'])
    expect(s.usage!.worst.label).toBe('5h')
    expect(s.usage!.windows.map((w) => w.label)).toEqual(['5h'])
  })

  it('reports no usage dot when every time window is hidden', () => {
    const s = summariseAccountDots(account([b5h, bWeek, bFable]), ['5h', 'Weekly'])
    expect(s.usage).toBeNull()
    expect(s.models.map((m) => m.label)).toEqual(['Fable'])
  })
})

describe('MultiAccountStatusline -- minimal mode rendering', () => {
  it('draws dots instead of bars, and one per bucket group', () => {
    sessionState.sessions = twoSessions({ rateLimitCurrent: 30, rateLimitWeekly: 12 })
    render()
    // Two accounts, each with only time windows -> one usage dot each, no bars.
    expect(container.querySelectorAll('[role="progressbar"]').length).toBe(0)
    expect(dots().length).toBe(2)
  })

  it('leaves the bars alone when the setting is absent', () => {
    settingsState.settings = { accountAliases: {}, accountColourOverrides: {} }
    sessionState.sessions = twoSessions({ rateLimitCurrent: 30, rateLimitWeekly: 12 })
    render()
    expect(container.querySelectorAll('[role="progressbar"]').length).toBe(4)
    expect(dots().length).toBe(0)
  })

  it('shows the friendly name when one is set, and the full email when not', () => {
    settingsState.settings.accountAliases = { 'a@x.com': 'Personal' }
    sessionState.sessions = twoSessions({ rateLimitCurrent: 30, rateLimitWeekly: 12 })
    render()
    const labels = [...container.querySelectorAll('[data-testid="multi-account-pill-label"]')]
      .map((n) => n.textContent)
    expect(labels).toContain('Personal')
    expect(labels).toContain('jane.doe@example.com')
  })

  it('paints the worst window red, and states it in words for the screen reader', () => {
    sessionState.sessions = [
      { id: '1', label: 'x', status: 'working', accountEmail: 'a@x.com', rateLimitCurrent: 5, rateLimitWeekly: 96 },
      { id: '2', label: 'y', status: 'working', accountEmail: 'jane.doe@example.com', rateLimitCurrent: 5, rateLimitWeekly: 5 },
    ]
    render()
    const rags = [...dots()].map((d) => d.getAttribute('data-rag'))
    expect(rags).toContain('red')
    expect(rags).toContain('green')
    const red = [...dots()].find((d) => d.getAttribute('data-rag') === 'red')!
    // Not colour alone: the state is in the accessible name too.
    expect(red.getAttribute('aria-label')).toContain('nearly exhausted')
    expect(red.getAttribute('aria-label')).toContain('Weekly')
  })

  it('puts the exact figures in the tooltip, since the dots only carry a band', () => {
    sessionState.sessions = twoSessions({ rateLimitCurrent: 30, rateLimitWeekly: 12 })
    render()
    const pill = container.querySelector('[data-testid="multi-account-pill"]')!
    expect(pill.getAttribute('title')).toContain('30%')
    expect(pill.getAttribute('title')).toContain('12%')
  })

  it('shows a NEUTRAL dot, never a green one, before anything is reported', () => {
    // No rateLimit fields at all -> the account is live but has reported nothing.
    settingsState.settings.statusLineEnabled = true
    sessionState.sessions = twoSessions()
    render()
    expect(container.querySelectorAll('[data-testid="account-usage-dot-pending"]').length).toBe(2)
    expect(dots().length).toBe(0)
  })
})
