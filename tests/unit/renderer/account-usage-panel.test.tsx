// @vitest-environment jsdom
//
// BUG 2 (#239 follow-up): the account-usage page was blind to active/inactive.
// The behavioural hole was the sign-in buttons — they opened a login shell for
// an account the user deliberately parked, bypassing the switcher's own
// active-guard. AccountCard now renders a parked card with NO sign-in and greys
// it. These tests pin exactly that: an inactive row offers neither button and
// shows the parked message; an active row still does.
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountCard } from '../../../src/renderer/components/AccountUsagePanel'
import type { AccountUsage } from '../../../src/shared/usage-types'

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
})
