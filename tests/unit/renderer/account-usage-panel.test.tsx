// @vitest-environment jsdom
//
// BUG 2 (#239 follow-up): the account-usage page was blind to active/inactive.
// The behavioural hole was the sign-in buttons — they opened a login shell for
// an account the user deliberately parked, bypassing the switcher's own
// active-guard. AccountCard now renders a parked card with NO sign-in and greys
// it. These tests pin exactly that: an inactive row offers neither button and
// shows the parked message; an active row still does.
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountCard, CodexAccountCard } from '../../../src/renderer/components/AccountUsagePanel'
import type { AccountUsage, UsageBucket } from '../../../src/shared/usage-types'
import type { AccountView, ProviderAccountUsageView } from '../../../src/shared/providers'
import { resolveIdentityColor } from '../../../src/shared/identity-colors'
import { formatResetTime } from '../../../src/renderer/utils/terminalFormatting'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

function render(ui: React.ReactElement) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return { container, unmount: () => { act(() => root.unmount()); container.remove() } }
}

const row = (over: Partial<AccountUsage>): AccountUsage => ({
  profileId: 'profile-x-1',
  email: 'x@example.com',
  name: 'Acct',
  isPrimary: false,
  status: 'ok',
  buckets: [],
  fetchedAt: 0,
  ...over,
})

function buttonTexts(c: HTMLElement): string[] {
  return Array.from(c.querySelectorAll('button')).map((b) => b.textContent?.trim() ?? '')
}

describe('AccountCard — active/inactive awareness', () => {
  it('an inactive account shows NO sign-in button and the parked message', () => {
    const onSignIn = vi.fn()
    const r = render(<AccountCard row={row({ status: 'inactive', active: false })} theme="dark" onSignIn={onSignIn} />)
    expect(buttonTexts(r.container)).toEqual([]) // neither "Sign in" nor "Refresh sign-in"
    expect(r.container.textContent).toContain('Inactive')
    expect(r.container.textContent).toMatch(/Parked/i)
    r.unmount()
  })

  it('treats active:false as inactive even if status was left ok (defensive gate)', () => {
    const r = render(<AccountCard row={row({ status: 'ok', active: false, buckets: [] })} theme="dark" onSignIn={vi.fn()} />)
    expect(buttonTexts(r.container)).toEqual([])
    expect(r.container.textContent).toMatch(/Parked/i)
    r.unmount()
  })

  it('a parked account left at needs-login shows NO blue Sign in button (defence in depth)', () => {
    // The one combo the greying gate is meant to cover but a status-only check
    // missed: an inactive account whose token has lapsed. The blue "Sign in"
    // block gates on status === 'needs-login'; without also excluding inactive it
    // would offer a live Sign in for a deliberately parked account.
    const r = render(<AccountCard row={row({ status: 'needs-login', active: false })} theme="dark" onSignIn={vi.fn()} />)
    expect(buttonTexts(r.container)).toEqual([])
    expect(r.container.textContent).toMatch(/Parked/i)
    r.unmount()
  })

  it('an active signed-out account still offers "Sign in"', () => {
    const r = render(<AccountCard row={row({ status: 'needs-login', active: true })} theme="dark" onSignIn={vi.fn()} />)
    expect(buttonTexts(r.container)).toContain('Sign in')
    expect(r.container.textContent).not.toMatch(/Parked/i)
    r.unmount()
  })

  it('an active signed-in account still offers "Refresh sign-in"', () => {
    const r = render(<AccountCard row={row({ status: 'ok', active: true, buckets: [] })} theme="dark" onSignIn={vi.fn()} />)
    expect(buttonTexts(r.container)).toContain('Refresh sign-in')
    r.unmount()
  })

  it('an undefined active field is treated as active (no migration, no greying)', () => {
    const r = render(<AccountCard row={row({ status: 'needs-login' })} theme="dark" onSignIn={vi.fn()} />)
    expect(buttonTexts(r.container)).toContain('Sign in')
    r.unmount()
  })

  // Usage track MP3 review (D5): an account of a provider that is off offers
  // nothing to act on and no sign-in countdown: nothing of it was read.
  it('an account of a provider that is off shows no "Refresh sign-in", no countdown and no warnings', () => {
    const auth = { profileId: 'profile-x-1', hasRefreshToken: true, refreshTokenExpiresAt: Date.now() + 3 * 86_400_000, duplicateOfProfileIds: ['profile-y-1'], identityMismatch: true, accountEmail: 'x@example.com', oauthEmail: 'y@example.com' }
    const r = render(<AccountCard row={row({ status: 'off', active: true })} auth={auth} theme="dark" onSignIn={vi.fn()} />)
    expect(buttonTexts(r.container)).toEqual([])
    expect(r.container.textContent).toContain('Claude Code is off')
    expect(r.container.textContent).not.toMatch(/days?|signed into the SAME account|Labelled/)
    r.unmount()
  })
})

// Usage track MP4 (the approved canvas, Account usage option A). Local times:
// the reset text is the app's own formatResetTime of the same instant.
const NOW = new Date(2026, 8, 27, 12, 0, 0).getTime()
const at = (h: number, m = 0, day = 27) => new Date(2026, 8, day, h, m, 0).toISOString()
const bucket = (label: string, percent: number, resetsAt: string): UsageBucket => ({ key: label, label, group: label === '5h' ? 'session' : 'weekly', percent, resetsAt, severity: 'normal' })
const rgb = (hex: string) => { const n = parseInt(hex.slice(1), 16); return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})` }
const q = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

describe('AccountCard: identity, D2 and ages (usage track MP4)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('leads with the identity name and colour, the email beside it', () => {
    const r = render(<AccountCard row={row({ email: 'work@example.com' })} identity={{ name: 'Work', colourKey: 'slate-blue' }} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(q(r.container, 'account-usage-name')?.textContent).toBe('Work')
    expect(q(r.container, 'account-usage-sub')?.textContent).toBe('work@example.com')
    expect(q(r.container, 'account-usage-chip')?.style.backgroundColor).toBe(rgb(resolveIdentityColor('slate-blue', 'dark')))
    r.unmount()
  })

  it('with no identity name (or one that is the email) it shows the email alone', () => {
    for (const identity of [undefined, { colourKey: 'pink' }, { name: 'client@example.org', colourKey: 'pink' }]) {
      const r = render(<AccountCard row={row({ email: 'client@example.org' })} identity={identity} theme="dark" onSignIn={vi.fn()} now={NOW} />)
      expect(q(r.container, 'account-usage-name')?.textContent).toBe('client@example.org')
      expect(q(r.container, 'account-usage-sub')).toBeNull()
      r.unmount()
    }
  })

  it('a window past its reset shows "Reset <time>, no reading since" and no figure; the others keep theirs (D2)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const past = at(9, 40)
    const r = render(<AccountCard row={row({ buckets: [bucket('5h', 34, past), bucket('Weekly', 58, at(9, 0, 30))] })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(r.container.textContent).toContain(`Reset ${formatResetTime(past)}, no reading since`)
    expect(r.container.textContent).not.toContain('34%')
    expect(r.container.textContent).toContain('58%')
    expect(r.container.querySelectorAll('[role="progressbar"]')).toHaveLength(1)
    r.unmount()
  })

  it('an age reads in hours and days, not minutes', () => {
    const r = render(<AccountCard row={row({ buckets: [bucket('Weekly', 5, at(9, 0, 30))], stale: true, fetchedAt: NOW - 5 * 3_600_000 })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(r.container.textContent).toMatch(/Last updated 5 h ago . couldn't refresh/)
    r.unmount()
    const d = render(<AccountCard row={row({ buckets: [bucket('Weekly', 5, at(9, 0, 30))], stale: true, fetchedAt: NOW - 26 * 3_600_000 })} theme="dark" onSignIn={vi.fn()} now={NOW} />)
    expect(d.container.textContent).toMatch(/Last updated 1 day ago/)
    d.unmount()
  })
})

const cxAccount = (over: Partial<AccountView> = {}): AccountView => ({
  id: 'acct-1', providerId: 'codex', identityId: 'identity-1', lifecycle: 'active', isProviderDefault: false, isReviewerDefault: false,
  authMethod: 'browser', lastKnownAuthState: 'signed-in', operationalState: 'ready', identityAssurance: 'user-asserted',
  realmLifecycle: 'active', external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0,
  ...over,
})
const cxView = (over: Partial<ProviderAccountUsageView> = {}): ProviderAccountUsageView => ({
  accountId: 'acct-1', providerId: 'codex', status: 'ok', source: 'live', readingAt: NOW,
  buckets: [bucket('5h', 18, at(14, 45)), bucket('Weekly', 47, at(18, 0, 30))], planLabel: 'Plus',
  ...over,
})
function cxCard(o: { account?: Partial<AccountView>; view?: Partial<ProviderAccountUsageView>; name?: string; method?: string | null; colour?: string | null; onSignInAgain?: () => void } = {}) {
  return render(
    <CodexAccountCard
      account={cxAccount(o.account)}
      view={cxView(o.view)}
      name={o.name ?? 'Work'}
      method={o.method === undefined ? 'ChatGPT sign-in' : o.method}
      colour={o.colour === undefined ? '#3ba8d4' : o.colour}
      now={NOW}
      onSignInAgain={o.onSignInAgain ?? vi.fn()}
    />,
  )
}

describe('CodexAccountCard (usage track MP4)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('an account with an open session: name, sign-in method, Default and plan, its bars, "Updated just now", and nothing to sign in', () => {
    const r = cxCard({ account: { isProviderDefault: true } })
    expect(q(r.container, 'account-usage-name')?.textContent).toBe('Work')
    expect(q(r.container, 'account-usage-sub')?.textContent).toBe('ChatGPT sign-in')
    expect(q(r.container, 'account-usage-chip')?.style.backgroundColor).toBe(rgb('#3ba8d4'))
    expect(Array.from(r.container.querySelectorAll('[data-testid="account-usage-pill"]')).map((p) => p.textContent)).toEqual(['Default', 'Plus'])
    expect(r.container.textContent).toContain('18%')
    expect(r.container.textContent).toContain('47%')
    expect(r.container.textContent).toContain('Updated just now')
    expect(buttonTexts(r.container)).toEqual([])
    expect(r.container.textContent).not.toMatch(/Forced sign-in|countdown/i)
    r.unmount()
  })

  it('a closed account shows its last-seen reading "As of <age>, from its latest session"', () => {
    const r = cxCard({ view: { source: 'last-seen', readingAt: NOW - 3 * 3_600_000, planLabel: 'Pro' } })
    expect(r.container.textContent).toContain('As of 3 h ago, from its latest session')
    expect(r.container.textContent).toContain('Pro')
    r.unmount()
  })

  it('a window past its reset reads "no reading since" (D2)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const past = at(11, 40)
    const r = cxCard({ view: { source: 'last-seen', buckets: [bucket('5h', 12, past), bucket('Weekly', 41, at(18, 0, 30))] } })
    expect(r.container.textContent).toContain(`Reset ${formatResetTime(past)}, no reading since`)
    expect(r.container.textContent).not.toContain('12%')
    expect(r.container.textContent).toContain('41%')
    r.unmount()
  })

  it('no session yet, and an API-key account, each say so and show no bars', () => {
    const none = cxCard({ view: { status: 'no-session-yet', buckets: [], source: undefined, readingAt: undefined, planLabel: undefined } })
    expect(none.container.textContent).toContain('No session on this account yet. Its allowance shows after the first one.')
    expect(none.container.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    none.unmount()
    const key = cxCard({ account: { authMethod: 'apiKey' }, method: 'API key', view: { status: 'per-token', buckets: [], source: undefined, readingAt: undefined, planLabel: undefined } })
    expect(key.container.textContent).toContain('Billed per token, so there is no plan allowance.')
    expect(q(key.container, 'account-usage-sub')?.textContent).toBe('API key')
    key.unmount()
  })

  it('this computer\'s own sign-in shows the "~" avatar and no chip or method', () => {
    const r = cxCard({ account: { external: true, authMethod: 'external' }, name: "This computer's Codex", method: null, colour: null })
    expect(q(r.container, 'account-usage-external')?.textContent).toBe('~')
    expect(q(r.container, 'account-usage-chip')).toBeNull()
    expect(q(r.container, 'account-usage-sub')).toBeNull()
    r.unmount()
  })

  it('a parked account shows Inactive and the parked line, and no plan or bars', () => {
    const r = cxCard({ account: { lifecycle: 'inactive' }, view: { status: 'inactive', buckets: [] } })
    expect(Array.from(r.container.querySelectorAll('[data-testid="account-usage-pill"]')).map((p) => p.textContent)).toEqual(['Inactive'])
    expect(r.container.textContent).toMatch(/Parked/)
    expect(r.container.querySelectorAll('[role="progressbar"]')).toHaveLength(0)
    r.unmount()
  })

  it('a signed-out account offers "Sign in again", with its last-seen reading', () => {
    const onSignInAgain = vi.fn()
    const r = cxCard({ onSignInAgain, account: { lastKnownAuthState: 'signed-out' }, view: { status: 'not-signed-in', source: 'last-seen', readingAt: NOW - 2 * 3_600_000 } })
    expect(buttonTexts(r.container)).toEqual(['Sign in again'])
    expect(r.container.textContent).toContain('18%')
    expect(r.container.textContent).toContain('As of 2 h ago, from its latest session')
    act(() => { (r.container.querySelector('button') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onSignInAgain).toHaveBeenCalledTimes(1)
    r.unmount()
  })
})
