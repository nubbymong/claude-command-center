/**
 * getBrowserPaths per-platform candidates.
 *
 * The Linux regression this pins: getBrowserPaths had no linux branch, so
 * Linux fell through to the WINDOWS list (C:\Program Files\...chrome.exe),
 * none of which exist — and launchBrowser's bare-name fallback was 'chrome',
 * which no mainstream distro ships. Net effect: `spawn chrome ENOENT` and
 * vision permanently disabled on Linux.
 */
import { describe, it, expect } from 'vitest'
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
    expect(getBrowserPaths('chrome', 'win32')).toEqual([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ])
    expect(getBrowserPaths('chrome', 'darwin')).toEqual([
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ])
    expect(getBrowserPaths('edge', 'win32')).toEqual([
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ])
    expect(getBrowserPaths('edge', 'darwin')).toEqual([
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ])
  })
})
