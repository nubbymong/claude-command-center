// [host] WP2 PR 4, P4.6 second half (row 58): the codexWeb boundary with the
// REAL handlers, session, window, pane and record modules wired as index.ts
// wires them; only Electron, the registry, the leases and the JSON file are
// faked. Adopted from the ADR-009 round's lens B and C probes.
//  - Archive and sign-out close the account's chatgpt.com panes BEFORE the
//    partition is wiped, so no open view can write the session back.
//  - While a clear runs, no pane or sign-in starts on that account.
//  - A pane opens only for a session that runs under the account.
//  - The shared session-keyed pane channels act on a Codex pane: close,
//    bounds, visibility, reload and state, minting no other partition.
import { describe, it, expect, beforeEach, vi } from 'vitest'

const S = vi.hoisted(() => {
  const handlers: Record<string, (e: unknown, ...a: unknown[]) => unknown> = {}
  const minted: string[] = []
  const sessions: Record<string, any> = {}
  const views: any[] = []
  const windows: any[] = []
  const trail: string[] = []
  const gates: { storage: null | Promise<void> } = { storage: null }
  const reg = { accounts: [] as Array<{ id: string; providerId: string; lifecycle: string }> }
  const holding: Record<string, string[]> = {}
  const disk: Record<string, unknown> = {}
  const flags = { writeFails: false }
  function fakeSession(partition: string) {
    minted.push(partition)
    if (sessions[partition]) return sessions[partition]
    const ses: any = {
      partition,
      ua: 'X (KHTML, like Gecko) App/1 Chrome/1 Electron/1',
      getUserAgent() { return this.ua },
      setUserAgent(v: string) { this.ua = v },
      setPermissionRequestHandler() {},
      on() {},
      jar: [] as any[],
      cookies: {
        listeners: [] as Function[],
        get: async (filter: any) => (typeof filter?.name === 'string' ? ses.jar.filter((c: any) => c.name === filter.name) : [...ses.jar]),
        on(_ev: string, fn: Function) { this.listeners.push(fn) },
        removeListener(_ev: string, fn: Function) { this.listeners = this.listeners.filter((f: Function) => f !== fn) },
      },
      clearStorageData: async () => {
        trail.push(`wipe ${partition} (open views on it: ${views.filter((v) => v.opts.webPreferences.partition === partition && !v.webContents.destroyed).length}, listeners: ${ses.cookies.listeners.length})`)
        if (gates.storage) await gates.storage
        ses.jar = []
      },
      clearCache: async () => {},
    }
    sessions[partition] = ses
    return ses
  }
  const MAIN_FRAME = { kind: 'app-main-frame' }
  const mainWin: any = {
    isDestroyed() { return false },
    webContents: { mainFrame: MAIN_FRAME, send() {} },
    contentView: {
      children: [] as any[],
      addChildView(v: any) { this.children.push(v) },
      removeChildView(v: any) { this.children = this.children.filter((x: any) => x !== v) },
    },
    once() {}, on() {},
  }
  class FakeWin {
    opts: any
    destroyed = false
    closedCbs: Function[] = []
    webContents: any
    constructor(opts: any) {
      this.opts = opts
      const h: Record<string, Function> = {}
      this.webContents = {
        handlers: h,
        on: (ev: string, fn: Function) => { h[ev] = fn },
        setWindowOpenHandler: (fn: Function) => { h.__open = fn },
        session: { setPermissionRequestHandler() {} },
        executeJavaScriptInIsolatedWorld: async () => null,
        executeJavaScript: async () => null,
        isDestroyed: () => this.destroyed,
      }
      windows.push(this)
    }
    loadURL = async () => {}
    isDestroyed() { return this.destroyed }
    destroy() { if (this.destroyed) return; this.destroyed = true; for (const c of this.closedCbs) c() }
    on(ev: string, fn: Function) { if (ev === 'closed') this.closedCbs.push(fn) }
  }
  class FakeView {
    webContents: any
    bounds: any = null
    constructor(public opts: any) {
      const h: Record<string, Function> = {}
      const wc: any = {
        handlers: h,
        destroyed: false,
        reloads: 0,
        on: (ev: string, fn: Function) => { h[ev] = fn },
        setWindowOpenHandler: (fn: Function) => { h.__open = fn },
        loadURL: async () => {},
        close() { wc.destroyed = true; trail.push('pane view closed') },
        isDestroyed() { return wc.destroyed },
        executeJavaScriptInIsolatedWorld: async () => null,
        executeJavaScript: async () => null,
        getURL: () => 'https://chatgpt.com/',
        getTitle: () => 'page',
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        reloadIgnoringCache() { wc.reloads++ },
      }
      this.webContents = wc
      views.push(this)
    }
    setBounds(b: any) { this.bounds = b }
  }
  return { handlers, minted, sessions, views, windows, trail, gates, reg, holding, disk, flags, fakeSession, mainWin, MAIN_FRAME, FakeWin, FakeView }
})

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => { S.handlers[ch] = fn }, on() {}, removeHandler() {} },
  BrowserWindow: S.FakeWin,
  WebContentsView: S.FakeView,
  shell: { openExternal: async () => {} },
  session: { fromPartition: (p: string) => S.fakeSession(p) },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: () => {}, logError: () => {}, logWarn: () => {} }))
vi.mock('../../src/main/provider-account-registry', () => ({
  getAccountRegistry: () => ({ current: () => ({ accounts: S.reg.accounts }) }),
  getConsumerLeases: () => ({ sessionsHolding: (id: string) => S.holding[id] ?? [] }),
}))
vi.mock('../../src/main/channel-storage', () => ({
  readJsonFile: (n: string, seed: () => unknown) => (S.disk[n] !== undefined ? JSON.parse(JSON.stringify(S.disk[n])) : seed()),
  writeJsonFile: (n: string, v: unknown) => {
    if (S.flags.writeFails) return false
    S.disk[n] = JSON.parse(JSON.stringify(v))
    return true
  },
}))
vi.mock('../../src/main/webview-manager', () => ({ closeWebview: () => false }))
vi.mock('../../src/main/account-web/sign-in', () => ({
  cancelSignIn: () => {}, clearWebSession: async () => {}, detectAuthBrowsers: () => [],
  getSignInState: () => ({ phase: 'idle' }), runSignIn: async () => ({ phase: 'failed' }),
}))
vi.mock('../../src/main/account-web/claude-cli-auth', () => ({ readClaudeCliAuth: async () => ({ authenticated: false }), claudeAuthCommand: () => '' }))
vi.mock('../../src/main/provider-launch-gate', () => ({ providerProbeRefusal: () => null }))
vi.mock('../../src/main/account-web/artifacts', () => ({ closeArtifacts: () => {}, openArtifacts: () => ({ ok: true }) }))
vi.mock('../../src/main/account-profiles', () => ({ listProfiles: () => [{ id: 'profile-known1' }] }))
vi.mock('../../src/main/data-paths', () => ({ getDataDirectory: () => 'Z:/test-nonexistent' }))

const { registerCodexWebHandlers } = await import('../../src/main/ipc/codex-web-handlers')
const { registerAccountWebHandlers } = await import('../../src/main/ipc/account-web-handlers')
const { IPC } = await import('../../src/shared/ipc-channels')
const CWS = await import('../../src/main/account-web/codex-web-session')
const PANE = await import('../../src/main/account-web/account-pane')
const STORE = await import('../../src/main/account-web/codex-web-store')

const ACCT = 'acct-0123456789abcdef'
const PART = `persist:codex-web-${ACCT}`
const BOUNDS = { x: 0, y: 0, width: 100, height: 100 }
const TRUSTED = { sender: S.mainWin.webContents, senderFrame: S.MAIN_FRAME }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const call = (ch: string, e: unknown, ...args: unknown[]) => S.handlers[ch](e, ...args) as Promise<any>

beforeEach(() => {
  PANE.closeAllAccountPanes()
  CWS._resetCodexWebForTest()
  for (const k of Object.keys(S.handlers)) delete S.handlers[k]
  for (const k of Object.keys(S.sessions)) delete S.sessions[k]
  for (const k of Object.keys(S.disk)) delete S.disk[k]
  for (const k of Object.keys(S.holding)) delete S.holding[k]
  S.minted.length = 0; S.views.length = 0; S.windows.length = 0; S.trail.length = 0
  S.gates.storage = null
  S.flags.writeFails = false
  S.reg.accounts = [{ id: ACCT, providerId: 'codex', lifecycle: 'inactive' }]
  S.holding[ACCT] = ['s1']
  // As index.ts wires them.
  registerCodexWebHandlers(() => S.mainWin, { sessionRunsUnder: (sid, acct) => (S.holding[acct] ?? []).includes(sid) })
  registerAccountWebHandlers()
  CWS.onCodexWebSessionClosing(PANE.closeCodexAccountPanes)
  CWS.onCodexWebSessionCleared(STORE.removeCodexWebSession)
})

async function openPane(sessionId = 's1') {
  const r = await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId, accountId: ACCT, bounds: BOUNDS })
  expect(r.ok).toBe(true)
  await sleep(20)
  return S.views[S.views.length - 1]
}

describe('[host] nothing holding the session is open while it is wiped', () => {
  it('archive: the pane is closed (its cookie listener gone) before the wipe starts, and nothing is recorded after', async () => {
    const view = await openPane()
    const release = await CWS.prepareCodexWebArchive(ACCT, 'codex')
    release()
    expect(S.trail.indexOf('pane view closed')).toBeGreaterThanOrEqual(0)
    expect(S.trail.indexOf('pane view closed')).toBeLessThan(S.trail.findIndex((t) => t.startsWith('wipe ')))
    expect(S.trail.find((t) => t.startsWith('wipe '))).toBe(`wipe ${PART} (open views on it: 0, listeners: 0)`)
    expect(view.webContents.destroyed).toBe(true)
    // A response that lands after the wipe has no open view to land in.
    S.sessions[PART].jar = [{ name: '__Secure-next-auth.session-token', value: 'x', expirationDate: 4102444800 }]
    expect(S.sessions[PART].cookies.listeners).toHaveLength(0)
    await sleep(50)
    expect(STORE.getCodexWebSession(ACCT)).toBeUndefined()
  })

  it('sign-out: the same order', async () => {
    await openPane()
    expect((await call(IPC.CODEX_WEB_SIGN_OUT, TRUSTED, ACCT)).ok).toBe(true)
    expect(S.trail.find((t) => t.startsWith('wipe '))).toBe(`wipe ${PART} (open views on it: 0, listeners: 0)`)
  })

  it('while the wipe is in flight, no pane and no sign-in starts on that account', async () => {
    let open!: () => void
    S.gates.storage = new Promise<void>((r) => { open = r })
    const out = call(IPC.CODEX_WEB_SIGN_OUT, TRUSTED, ACCT)
    await sleep(20)
    expect((await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 's1', accountId: ACCT, bounds: BOUNDS })).ok).toBe(false)
    expect((await call(IPC.CODEX_WEB_SIGN_IN, TRUSTED, ACCT)).ok).toBe(false)
    expect(S.windows).toHaveLength(0)
    open(); S.gates.storage = null
    expect((await out).ok).toBe(true)
    // After the clear the account is usable again.
    expect((await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 's1', accountId: ACCT, bounds: BOUNDS })).ok).toBe(true)
  })
})

describe('[host] a pane opens only for a session that runs under the account', () => {
  it('a session holding the account opens it; one that does not gets nothing, and no partition is made', async () => {
    expect((await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 'claude-session-7', accountId: ACCT, bounds: BOUNDS })).ok).toBe(false)
    expect(S.minted).toEqual([])
    await openPane('s1')
    expect(S.minted).toContain(PART)
  })
})

describe('[host] the shared session-keyed pane channels act on a Codex pane', () => {
  it('state, bounds, visibility, reload and close reach the Codex pane and mint no other partition', async () => {
    STORE.saveCodexWebSession({ accountId: ACCT, accountEmail: 'owner@example.com', acquiredAt: 1, expiresAt: null, origin: 'in-app' })
    const view = await openPane()
    const minted = new Set(S.minted)
    expect(await call(IPC.ACCOUNT_WEB_PANE_GET_STATE, TRUSTED, 's1')).toEqual({ ok: true, state: { sessionId: 's1', service: 'codex', accountId: ACCT, authed: false, email: 'owner@example.com' } })
    expect((await call(IPC.ACCOUNT_WEB_PANE_BOUNDS, TRUSTED, { sessionId: 's1', bounds: { x: 1, y: 2, width: 3, height: 4 } })).ok).toBe(true)
    expect(view.bounds).toEqual({ x: 1, y: 2, width: 3, height: 4 })
    expect((await call(IPC.ACCOUNT_WEB_PANE_VISIBLE, TRUSTED, { sessionId: 's1', visible: false })).ok).toBe(true)
    expect(S.mainWin.contentView.children).not.toContain(view)
    expect((await call(IPC.ACCOUNT_WEB_PANE_RELOAD, TRUSTED, 's1')).ok).toBe(true)
    expect(view.webContents.reloads).toBe(1)
    expect(new Set(S.minted)).toEqual(minted)
    expect(await call(IPC.ACCOUNT_WEB_PANE_CLOSE, TRUSTED, 's1')).toEqual({ ok: true, closed: true })
    expect(view.webContents.destroyed).toBe(true)
  })
})

describe('[host] a record that cannot be written or removed never reads as done or signed out', () => {
  const REC = { accountId: ACCT, accountEmail: 'owner@example.com', acquiredAt: 1, expiresAt: null, origin: 'in-app' as const }

  it('the store says so when a write fails', () => {
    S.flags.writeFails = true
    expect(STORE.saveCodexWebSession(REC)).toBe(false)
    S.flags.writeFails = false
    expect(STORE.saveCodexWebSession(REC)).toBe(true)
    S.flags.writeFails = true
    expect(STORE.removeCodexWebSession(ACCT)).toBe(false)
  })

  it('sign-out reports a record it could not remove, and the record stays', async () => {
    STORE.saveCodexWebSession(REC)
    S.flags.writeFails = true
    const r = await call(IPC.CODEX_WEB_SIGN_OUT, TRUSTED, ACCT)
    S.flags.writeFails = false
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/record could not be removed/) })
    expect(STORE.getCodexWebSession(ACCT)).toMatchObject({ accountEmail: 'owner@example.com' })
  })

  it('the archive hook rejects (so the archive is refused) when the record could not be removed', async () => {
    STORE.saveCodexWebSession(REC)
    S.flags.writeFails = true
    await expect(CWS.prepareCodexWebArchive(ACCT, 'codex')).rejects.toThrow(/record could not be removed/)
    S.flags.writeFails = false
    expect(STORE.getCodexWebSession(ACCT)).toBeDefined()
  })
})
