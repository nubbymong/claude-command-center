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

const LOCAL = 'C:\\Users\\jo\\AppData\\Local'
const SYSTEM_EDGE = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
const SYSTEM_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const USER_EDGE = `${LOCAL}\\Microsoft\\Edge\\Application\\msedge.exe`
const USER_CHROME = `${LOCAL}\\Google\\Chrome\\Application\\chrome.exe`

// The reporter's machine: a system-wide Edge, a per-user Chrome, nothing else.
const REPORTER_MACHINE = [SYSTEM_EDGE, USER_CHROME]
const PRESENT = new Set(REPORTER_MACHINE)
vi.mock('node:fs', () => ({
  existsSync: (p: string) => PRESENT.has(String(p)),
  readFileSync: () => '',
  readdirSync: () => [],
  rmSync: vi.fn(),
}))

const { detectAuthBrowsers, resolveBrowserBinary } = await import('../../src/main/account-web/sign-in')

beforeEach(() => {
  delete fakeEnv.LOCALAPPDATA
  PRESENT.clear()
  for (const p of REPORTER_MACHINE) PRESENT.add(p)
})

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
    expect(resolveBrowserBinary('chrome')).toEqual({ browser: 'chrome', path: USER_CHROME })
  })

  it('Edge still resolves first to its system-wide install', () => {
    fakeEnv.LOCALAPPDATA = LOCAL
    expect(resolveBrowserBinary('edge')).toEqual({ browser: 'edge', path: SYSTEM_EDGE })
  })
})

// The two branches the adversarial pass found correct but unasserted: the
// tie-break when a browser is installed BOTH ways, and the machine with no
// admin rights at all -- the exact user this fix is for.
describe('detectAuthBrowsers — tie-breaks and the no-admin machine', () => {
  it('with BOTH a system and a per-user Chrome present, the system install wins', () => {
    fakeEnv.LOCALAPPDATA = LOCAL
    PRESENT.add(SYSTEM_CHROME)
    expect(resolveBrowserBinary('chrome')).toEqual({ browser: 'chrome', path: SYSTEM_CHROME })
  })

  it('per-user Edge + per-user Chrome, no system installs: both detected, each its own binary', () => {
    fakeEnv.LOCALAPPDATA = LOCAL
    PRESENT.clear()
    PRESENT.add(USER_EDGE)
    PRESENT.add(USER_CHROME)
    expect(detectAuthBrowsers()).toEqual(['edge', 'chrome'])
    expect(resolveBrowserBinary('edge')?.path).toBe(USER_EDGE)
    expect(resolveBrowserBinary('chrome')?.path).toBe(USER_CHROME)
  })

  it('a per-user Edge alone is one browser: the #439 gate still hides the picker, and the fallback is named', () => {
    fakeEnv.LOCALAPPDATA = LOCAL
    PRESENT.clear()
    PRESENT.add(USER_EDGE)
    expect(detectAuthBrowsers()).toEqual(['edge'])
    // Asking for Chrome is answered by Edge -- the launcher reports that
    // substitution rather than hiding it (account-web-browser-fallback.test.ts).
    expect(resolveBrowserBinary('chrome')).toEqual({ browser: 'edge', path: USER_EDGE })
  })
})
