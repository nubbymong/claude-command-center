// @vitest-environment jsdom
//
// WP1.38 layer 4: the surface that makes a missing account-isolation control
// visible. Without this component the preflight is write-only, and a session
// that started WITHOUT its control looks exactly like one that did.
//
// The load-bearing case here is "CLEARS once the newest launch is clean". The
// first version of this component scanned every retained report and kept the
// first occurrence of each finding id, which answers "has anything ever gone
// wrong" rather than "is my account isolation OK now" -- so a user who
// installed the CLI, or fixed their JSON, kept being told to do the thing they
// had just done until fifty more sessions pushed the stale report out of the
// ring buffer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountIsolationNotice } from '../../../src/renderer/components/settings/AccountIsolationNotice'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const HOME = 'C:/profiles/p1'
const blocked = (id: string) => ({ id, severity: 'blocked' as const, title: `T ${id}`, detail: `D ${id}`, action: `A ${id}` })
const info = (id: string) => ({ id, severity: 'info' as const, title: `T ${id}`, detail: `D ${id}` })
const report = (home: string, at: number, findings: Array<{ severity: string }>) => ({
  home, sessionId: `s${at}`, at,
  preflight: { ok: !findings.some((f) => f.severity === 'blocked'), findings },
})

function mockApi(reports: unknown, opts: { throws?: boolean; absent?: boolean } = {}) {
  ;(globalThis as any).window.electronAPI = {
    accountProfiles: opts.absent ? {} : {
      managedLaunchReports: opts.throws
        ? vi.fn(() => Promise.reject(new Error('ipc down')))
        : vi.fn(() => Promise.resolve(reports)),
    },
  }
}

let container: HTMLDivElement
let root: Root

async function mount() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(createElement(AccountIsolationNotice)) })
  // Drain the fetch promise chain the effect started.
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve() })
}

const find = (id: string) => container.querySelector(`[data-testid="${id}"]`)
const findAll = (id: string) => container.querySelectorAll(`[data-testid="${id}"]`)

beforeEach(() => { vi.clearAllMocks() })
afterEach(async () => {
  await act(async () => { root?.unmount() })
  container?.remove()
})

describe('AccountIsolationNotice', () => {
  it('renders nothing when every recent launch was clean', async () => {
    mockApi([report(HOME, 2, [])])
    await mount()
    expect(find('account-isolation-notice')).toBeNull()
  })

  it('shows a blocked finding with its action', async () => {
    mockApi([report(HOME, 2, [blocked('cli-below-floor')])])
    await mount()
    const row = find('isolation-finding-cli-below-floor')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('A cli-below-floor')
  })

  it('CLEARS once the newest launch for that home is clean', async () => {
    // Newest first. A stale report must not keep the warning on screen after
    // the user has fixed the thing it complains about.
    mockApi([
      report(HOME, 3, []),                                   // newest: fixed
      report(HOME, 2, [blocked('cli-version-unverified')]),  // older: the complaint
      report(HOME, 1, [blocked('settings-copy-refused')]),
    ])
    await mount()
    expect(find('account-isolation-notice')).toBeNull()
  })

  it('keeps a finding that is still current for ANOTHER profile', async () => {
    mockApi([
      report(HOME, 3, []),
      report('C:/profiles/p2', 2, [blocked('cli-below-floor')]),
    ])
    await mount()
    expect(find('isolation-finding-cli-below-floor')).not.toBeNull()
  })

  it('deduplicates one problem across several profiles into one row', async () => {
    mockApi([
      report(HOME, 3, [blocked('cli-below-floor')]),
      report('C:/profiles/p2', 2, [blocked('cli-below-floor')]),
    ])
    await mount()
    expect(findAll('isolation-finding-cli-below-floor')).toHaveLength(1)
  })

  it('keeps info findings behind a toggle rather than dropping them', async () => {
    // The ambient strip is wide and changes how a session behaves relative to
    // the user's own shell; a change nobody can see is what this panel exists
    // to end. Quiet, not absent.
    mockApi([report(HOME, 2, [info('ambient-authority-stripped')])])
    await mount()
    const toggle = find('isolation-info-toggle') as HTMLButtonElement
    expect(toggle).not.toBeNull()
    expect(find('isolation-finding-ambient-authority-stripped')).toBeNull()
    await act(async () => { toggle.click() })
    expect(find('isolation-finding-ambient-authority-stripped')).not.toBeNull()
  })

  it('survives an IPC failure without breaking the Accounts panel', async () => {
    mockApi(undefined, { throws: true })
    await mount()
    expect(find('account-isolation-notice')).toBeNull()
  })

  it('survives a preload that does not expose the channel at all', async () => {
    mockApi(undefined, { absent: true })
    await mount()
    expect(find('account-isolation-notice')).toBeNull()
  })
})
