// @vitest-environment jsdom
//
// WP1.38 layer 4: the surface that makes a missing account-isolation control
// visible. Without this component the preflight is write-only, and a session
// that started WITHOUT its control looks exactly like one that did.
//
// Two things are load-bearing here, and they are the two the component got
// wrong in turn:
//
//  1. "CLEARS once the newest launch is clean". The first version scanned every
//     retained report and kept the first occurrence of each finding id, which
//     answers "has anything ever gone wrong" rather than "is my account
//     isolation OK now" -- so a user who installed the CLI, or fixed their
//     JSON, kept being told to do the thing they had just done until fifty more
//     sessions pushed the stale report out of the ring buffer.
//
//  2. ONE PROFILE PER NOTICE. The version after that merged every account's
//     reports into one list and deduped by finding id, so a second account's
//     occurrence was not merely unattributed, it was INVISIBLE -- and the
//     detail text carried that other account's stripped settings keys and
//     ambient variable names across the boundary this panel defends
//     (adversarial review, MAJOR 5). The component now takes a `profileId`,
//     asks for that profile's reports alone, and renders per account row.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountIsolationNotice } from '../../../src/renderer/components/settings/AccountIsolationNotice'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const P1 = 'p1'
const blocked = (id: string) => ({ id, severity: 'blocked' as const, title: `T ${id}`, detail: `D ${id}`, action: `A ${id}` })
const info = (id: string) => ({ id, severity: 'info' as const, title: `T ${id}`, detail: `D ${id}` })
/** A report as the main process hands it over: already scoped to ONE profile,
 *  and with no absolute home path on it -- that path carries the OS username
 *  and is deliberately not on the wire. */
const report = (profileId: string, at: number, findings: Array<{ severity: string }>) => ({
  profileId, sessionId: `s${at}`, at,
  preflight: { ok: !findings.some((f) => f.severity === 'blocked'), findings },
})

let lastRequestedProfileId: unknown
function mockApi(reports: unknown, opts: { throws?: boolean; absent?: boolean } = {}) {
  lastRequestedProfileId = undefined
  ;(globalThis as any).window.electronAPI = {
    accountProfiles: opts.absent ? {} : {
      managedLaunchReports: opts.throws
        ? vi.fn(() => Promise.reject(new Error('ipc down')))
        : vi.fn((profileId: unknown) => { lastRequestedProfileId = profileId; return Promise.resolve(reports) }),
    },
  }
}

let container: HTMLDivElement
let root: Root

async function mount(profileId = P1) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(createElement(AccountIsolationNotice, { profileId })) })
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
  it("asks for ONE profile's reports, by id", async () => {
    // The scoping is done by the channel, not by filtering in the renderer, so
    // the absolute home path and another account's stripped key names never
    // cross the boundary in the first place.
    mockApi([report(P1, 2, [])])
    await mount()
    expect(lastRequestedProfileId).toBe(P1)
  })

  it('renders nothing when every recent launch was clean', async () => {
    mockApi([report(P1, 2, [])])
    await mount()
    expect(find(`account-isolation-notice-${P1}`)).toBeNull()
  })

  it('renders nothing when the profile has no reports at all', async () => {
    mockApi([])
    await mount()
    expect(find(`account-isolation-notice-${P1}`)).toBeNull()
  })

  it("shows a blocked finding with its action, inside THIS profile's notice", async () => {
    mockApi([report(P1, 2, [blocked('cli-below-floor')])])
    await mount()
    expect(find(`account-isolation-notice-${P1}`)).not.toBeNull()
    const row = find('isolation-finding-cli-below-floor')
    expect(row).not.toBeNull()
    expect(row!.textContent).toContain('A cli-below-floor')
  })

  it('CLEARS once the newest launch for that profile is clean', async () => {
    // Newest first. A stale report must not keep the warning on screen after
    // the user has fixed the thing it complains about.
    mockApi([
      report(P1, 3, []),                                   // newest: fixed
      report(P1, 2, [blocked('cli-version-unverified')]),  // older: the complaint
      report(P1, 1, [blocked('settings-copy-refused')]),
    ])
    await mount()
    expect(find(`account-isolation-notice-${P1}`)).toBeNull()
  })

  it('reports the newest launch even when it was not a PTY session', async () => {
    // Since the preflight moved into the launch choke point, a profile used
    // only for headless runs, insights or cloud agents produces reports too --
    // and those were the four paths that used to produce none at all
    // (adversarial review, MAJOR 9). The panel must not care which it was.
    mockApi([{ ...report(P1, 4, [blocked('cli-below-floor')]), sessionId: 'insights' }])
    await mount()
    expect(find('isolation-finding-cli-below-floor')).not.toBeNull()
  })

  it('ignores the app\'s OWN probe when picking the newest launch', async () => {
    // This panel triggers an `auth status` probe from every account row's
    // mount. That probe is a real managed launch and records a real report --
    // newer than the session it is meant to describe, and carrying no project
    // directory. Answering with the newest report therefore meant OPENING the
    // panel replaced what the panel was about to show (adversarial review,
    // MAJOR).
    mockApi([
      { ...report(P1, 9, []), sessionId: 'auth-status', kind: 'probe' },
      { ...report(P1, 8, [blocked('cli-below-floor')]), sessionId: 's-real', kind: 'launch' },
    ])
    await mount()
    expect(find('isolation-finding-cli-below-floor'), 'the probe displaced the real launch').not.toBeNull()
  })

  it('falls back to a probe when a profile has nothing else', async () => {
    // Showing nothing about a launch that did happen would be worse.
    mockApi([{ ...report(P1, 9, [blocked('cli-below-floor')]), sessionId: 'auth-status', kind: 'probe' }])
    await mount()
    expect(find('isolation-finding-cli-below-floor')).not.toBeNull()
  })

  it('shows one row per distinct finding id in the newest report', async () => {
    mockApi([report(P1, 3, [blocked('cli-below-floor'), blocked('cli-below-floor'), blocked('host-control-missing')])])
    await mount()
    expect(findAll('isolation-finding-cli-below-floor')).toHaveLength(1)
    expect(findAll('isolation-finding-host-control-missing')).toHaveLength(1)
  })

  it('keeps info findings behind a toggle rather than dropping them', async () => {
    // The ambient strip is wide and changes how a session behaves relative to
    // the user's own shell; a change nobody can see is what this panel exists
    // to end. Quiet, not absent.
    mockApi([report(P1, 2, [info('ambient-authority-stripped')])])
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
    expect(find(`account-isolation-notice-${P1}`)).toBeNull()
  })

  it('survives a preload that does not expose the channel at all', async () => {
    mockApi(undefined, { absent: true })
    await mount()
    expect(find(`account-isolation-notice-${P1}`)).toBeNull()
  })
})
