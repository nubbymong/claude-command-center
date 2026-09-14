// #216 — the surfaces an adversarial pass found had ZERO coverage.
//
// Mutation testing showed changes that shipped green: artifacts opening on a
// SHARED partition (cross-account bleed), artifacts with `sandbox: false`, and
// its navigation allowlist neutered. None is caught by the pure-function tests,
// because none lives in a pure function. These pin them.
//
// Each test uses a DISTINCT profile id: openArtifacts caches one window per
// profile, so reusing an id would return the cached window and record nothing —
// a test that silently stops asserting.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const created: { opts: any; win: any }[] = []
const openedExternal: string[] = []
const permissionHandlers: any[] = []

class FakeWindow {
  webContents: any
  private destroyed = false
  private closedCb?: () => void
  constructor(public opts: any) {
    const handlers: Record<string, Function> = {}
    this.webContents = {
      handlers,
      on: (ev: string, fn: Function) => { handlers[ev] = fn },
      setWindowOpenHandler: (fn: Function) => { handlers.__open = fn },
      session: { setPermissionRequestHandler: (fn: any) => permissionHandlers.push(fn) },
      loadURL: async () => {},
    }
    created.push({ opts, win: this })
  }
  focus() {}
  isDestroyed() { return this.destroyed }
  close() { this.destroyed = true; this.closedCb?.() }
  on(ev: string, fn: () => void) { if (ev === 'closed') this.closedCb = fn }
  // loadURL lives on the WINDOW, not on webContents — matching the real API the
  // code under test calls.
  async loadURL(_u: string) {}
}

vi.mock('electron', () => ({
  BrowserWindow: FakeWindow,
  shell: { openExternal: async (u: string) => { openedExternal.push(u) } },
  session: { fromPartition: vi.fn(() => ({ cookies: { set: vi.fn() }, clearStorageData: vi.fn() })) },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

const { openArtifacts, ARTIFACTS_URL } = await import('../../src/main/account-web/artifacts')
const { webPartitionForProfile } = await import('../../src/shared/account-web-session')
const { safeExternalHttpsHref } = await import('../../src/shared/safe-url')

beforeEach(() => { created.length = 0; openedExternal.length = 0; permissionHandlers.length = 0 })

describe('the artifacts window', () => {
  it('opens on THAT ACCOUNT’S partition — never a shared one', () => {
    openArtifacts('profile-p1a')
    openArtifacts('profile-p1b')
    const parts = created.map((c) => c.opts.webPreferences.partition)
    expect(parts[0]).toBe(webPartitionForProfile('profile-p1a'))
    expect(parts[1]).toBe(webPartitionForProfile('profile-p1b'))
    // A shared partition here reintroduces exactly the cross-account bleed the
    // per-account model exists to prevent.
    expect(parts[0]).not.toBe(parts[1])
  })

  it('is sandboxed with no bridge into the main process', () => {
    openArtifacts('profile-p2')
    const wp = created[0].opts.webPreferences
    expect(wp.sandbox).toBe(true)
    expect(wp.contextIsolation).toBe(true)
    expect(wp.nodeIntegration).toBe(false)
    expect(wp.preload).toBeUndefined()
  })

  it('denies every permission request', () => {
    openArtifacts('profile-p3')
    expect(permissionHandlers).toHaveLength(1)
    const cb = vi.fn()
    permissionHandlers[0](null, 'media', cb)
    expect(cb).toHaveBeenCalledWith(false)
  })

  it('refuses a profile id that is not the expected shape, opening nothing', () => {
    const r = openArtifacts('../evil')
    expect(r.ok).toBe(false)
    expect(created).toHaveLength(0)
  })

  it('opens at the artifacts page', () => {
    expect(ARTIFACTS_URL).toBe('https://claude.ai/artifacts')
  })
})

describe('artifacts navigation — this window holds a live session', () => {
  it('blocks navigation off claude.ai on BOTH will-navigate and will-redirect', () => {
    openArtifacts('profile-p4')
    const h = created[0].win.webContents.handlers
    // will-redirect matters independently: a 302 off claude.ai would otherwise
    // carry the session-bearing window off the allowlist with no will-navigate.
    for (const ev of ['will-navigate', 'will-redirect']) {
      expect(typeof h[ev]).toBe('function')
      const e = { preventDefault: vi.fn() }
      h[ev](e, 'https://evil.example/steal')
      expect(e.preventDefault).toHaveBeenCalled()
    }
  })

  it('allows navigation within claude.ai', () => {
    openArtifacts('profile-p5')
    const h = created[0].win.webContents.handlers
    const e = { preventDefault: vi.fn() }
    h['will-navigate'](e, 'https://claude.ai/artifacts/abc')
    expect(e.preventDefault).not.toHaveBeenCalled()
  })

  it('never hands a non-https scheme to the OS handler', () => {
    openArtifacts('profile-p6')
    const h = created[0].win.webContents.handlers
    // shell.openExternal is an OS-handler sink: file:, ms-msdt:, shell: reach
    // real handlers, and file://attacker-share/ is an NTLM leak. The repo has
    // safeExternalHttpsHref for exactly this; an inline copy that omits the
    // check is how a guarded sink becomes an unguarded one.
    for (const bad of ['file://attacker/share/x.lnk', 'ms-msdt:-id PCWDiagnostic', 'javascript:alert(1)']) {
      h['will-navigate']({ preventDefault: vi.fn() }, bad)
    }
    expect(openedExternal).toEqual([])

    h['will-navigate']({ preventDefault: vi.fn() }, 'https://example.com/ok')
    expect(openedExternal).toEqual(['https://example.com/ok'])
  })

  it('pins the underlying URL control', () => {
    expect(safeExternalHttpsHref('file://x/y')).toBeNull()
    expect(safeExternalHttpsHref('https://example.com/x')).toBe('https://example.com/x')
  })
})
