// aicc_planning#43 — the SSO "Sign-in browser" picker vanished on a managed
// machine that has BOTH browsers installed.
//
// Mechanism: Chrome was a per-user install (%LOCALAPPDATA%, the no-admin
// default), `getBrowserPaths('chrome')` listed only the Program Files locations,
// so `resolveBrowserBinary('chrome')` fell back to Edge, `detectAuthBrowsers()`
// kept only browsers that resolved to THEMSELVES, reported `['edge']`, and the
// picker's `length > 1` gate hid the Edge/Chrome choice. This file drives the
// real detection code over the real path list with a fake filesystem, and
// proves the old list fails where the new one passes.
import { describe, it, expect, beforeEach } from 'vitest'
import { vi } from 'vitest'

vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn(() => ({ cookies: { set: vi.fn() }, clearStorageData: vi.fn() })),
  },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

// The REAL path list, pinned to Windows with a controllable env so the test is
// the same on the Windows and macOS CI runners.
const fakeEnv: { LOCALAPPDATA?: string } = {}
vi.mock('../../src/main/browser-paths', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/browser-paths')>()
  return {
    getBrowserPaths: (b: 'chrome' | 'edge') => real.getBrowserPaths(b, 'win32', fakeEnv),
  }
})

// The reporter's machine: a system-wide Edge, a per-user Chrome, nothing else.
const LOCAL = 'C:\\Users\\jo\\AppData\\Local'
const PRESENT = new Set([
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  `${LOCAL}\\Google\\Chrome\\Application\\chrome.exe`,
])
vi.mock('node:fs', () => ({
  existsSync: (p: string) => PRESENT.has(String(p)),
  readFileSync: () => '',
  readdirSync: () => [],
  rmSync: vi.fn(),
}))

const { detectAuthBrowsers, resolveBrowserBinary } = await import('../../src/main/account-web/sign-in')

beforeEach(() => { delete fakeEnv.LOCALAPPDATA })

describe('detectAuthBrowsers — a per-user Chrome beside a system Edge (aicc_planning#43)', () => {
  it('REGRESSION: with only the Program Files candidates, Chrome is invisible and the picker gate closes', () => {
    // No %LOCALAPPDATA% = the pre-fix list. This is the bug: one browser
    // detected on a machine that has two.
    expect(detectAuthBrowsers()).toEqual(['edge'])
    // ...because asking for Chrome quietly hands back Edge.
    expect(resolveBrowserBinary('chrome')?.browser).toBe('edge')
  })

  it('with the per-user location in the list, both browsers are detected', () => {
    fakeEnv.LOCALAPPDATA = LOCAL
    expect(detectAuthBrowsers()).toEqual(['edge', 'chrome'])
  })

  it('a per-user Chrome resolves to ITS OWN binary, not to Edge', () => {
    fakeEnv.LOCALAPPDATA = LOCAL
    expect(resolveBrowserBinary('chrome')).toEqual({
      browser: 'chrome',
      path: `${LOCAL}\\Google\\Chrome\\Application\\chrome.exe`,
    })
  })

  it('Edge still resolves first to its system-wide install', () => {
    fakeEnv.LOCALAPPDATA = LOCAL
    expect(resolveBrowserBinary('edge')).toEqual({
      browser: 'edge',
      path: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    })
  })
})
