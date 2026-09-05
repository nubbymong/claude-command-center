/**
 * getBrowserPaths per-platform candidates.
 *
 * The Linux regression this pins: getBrowserPaths had no linux branch, so
 * Linux fell through to the WINDOWS list (C:\Program Files\...chrome.exe),
 * none of which exist — and launchBrowser's bare-name fallback was 'chrome',
 * which no mainstream distro ships. Net effect: `spawn chrome ENOENT` and
 * vision permanently disabled on Linux.
 */
import { describe, it, expect, vi } from 'vitest'
import { getBrowserPaths } from '../../src/main/vision-manager'

describe('vision getBrowserPaths', () => {
  it('linux chrome candidates cover google-chrome and chromium (deb/rpm)', () => {
    const paths = getBrowserPaths('chrome', 'linux')
    expect(paths).toContain('/usr/bin/google-chrome')
    expect(paths).toContain('/usr/bin/chromium')
    // Rocky/EL EPEL build ships this name — verified on Rocky 10
    expect(paths).toContain('/usr/bin/chromium-browser')
    // Never a Windows path on linux
    expect(paths.some((p) => p.includes('\\'))).toBe(false)
  })

  it('linux list excludes snap chromium (confinement blocks the CDP profile dir)', () => {
    // /snap/bin/chromium spawns but snap confinement rejects --user-data-dir
    // under /tmp, so the debug port never opens and vision hangs on
    // "launching" instead of cleanly disabling. deb/rpm builds only.
    const paths = getBrowserPaths('chrome', 'linux')
    expect(paths.some((p) => p.startsWith('/snap/'))).toBe(false)
  })

  it('linux edge candidates are the microsoft-edge install locations', () => {
    const paths = getBrowserPaths('edge', 'linux')
    expect(paths).toContain('/usr/bin/microsoft-edge')
    expect(paths).toContain('/usr/bin/microsoft-edge-stable')
  })

  it('windows and macOS lists are unchanged by the linux addition', () => {
    // An empty env pins the historical Windows lists exactly: no %LOCALAPPDATA%,
    // no per-user entry.
    expect(getBrowserPaths('chrome', 'win32', {})).toEqual([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ])
    expect(getBrowserPaths('chrome', 'darwin')).toEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ])
    expect(getBrowserPaths('edge', 'win32', {})).toEqual([
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ])
    expect(getBrowserPaths('edge', 'darwin')).toEqual([
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ])
  })

  // aicc_planning#43 -- a managed machine's no-admin Chrome lives under
  // %LOCALAPPDATA%, not Program Files. The list must include it, AFTER the
  // system-wide candidates so an existing system install keeps winning.
  describe('windows per-user installs (%LOCALAPPDATA%)', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\jo\\AppData\\Local' }

    it('chrome: the per-user path is appended after the system paths', () => {
      expect(getBrowserPaths('chrome', 'win32', env)).toEqual([
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Users\\jo\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      ])
    })

    it('edge: the per-user path is appended after the system paths', () => {
      expect(getBrowserPaths('edge', 'win32', env)).toEqual([
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Users\\jo\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
      ])
    })

    it('no %LOCALAPPDATA% (absent or empty) means no per-user entry -- never a bare or "undefined" path', () => {
      for (const noLocal of [{}, { LOCALAPPDATA: '' }]) {
        for (const b of ['chrome', 'edge'] as const) {
          const paths = getBrowserPaths(b, 'win32', noLocal)
          // The shape check first: a `!== undefined` guard would let an empty
          // variable through as `\Google\Chrome\...`, which this catches before
          // the length assertion can mask it.
          expect(paths.some((p) => /undefined|^\\/.test(p))).toBe(false)
          expect(paths).toHaveLength(2)
        }
      }
    })

    it('reads %LOCALAPPDATA% from process.env by default -- the wiring production relies on', () => {
      // Every other case passes an explicit env; this is the only one that
      // proves the default parameter is process.env and the key is spelled
      // the way Windows spells it.
      vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\jo\\AppData\\Local')
      try {
        expect(getBrowserPaths('chrome', 'win32')).toContain(
          'C:\\Users\\jo\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
        )
        expect(getBrowserPaths('edge', 'win32')).toContain(
          'C:\\Users\\jo\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
        )
      } finally {
        vi.unstubAllEnvs()
      }
    })

    it('per-user entries are windows-only: linux and macOS ignore the variable', () => {
      for (const b of ['chrome', 'edge'] as const) {
        expect(getBrowserPaths(b, 'linux', env).some((p) => p.includes('AppData'))).toBe(false)
        expect(getBrowserPaths(b, 'darwin', env).some((p) => p.includes('AppData'))).toBe(false)
      }
    })
  })
})
