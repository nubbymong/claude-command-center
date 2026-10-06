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
  const gates: { storage: null | Promise<void>; queue: Array<Promise<void>>; waiting: number } = { storage: null, queue: [], waiting: 0 }
  const reg = { accounts: [] as Array<{ id: string; providerId: string; lifecycle: string }> }
  const L: { leases: any; first: any } = { leases: null, first: null }
  const codexPty = new Set<string>()
  const sent: Array<[string, unknown]> = []
  const disk: Record<string, unknown> = {}
  const flags = { writeFails: false, writeThrows: false }
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
        const queued = gates.queue.shift()
        if (queued) { gates.waiting++; try { await queued } finally { gates.waiting-- } }
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
    webContents: { mainFrame: MAIN_FRAME, send(ch: string, p: unknown) { sent.push([ch, p]) } },
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
  return { handlers, minted, sessions, views, windows, trail, gates, reg, L, codexPty, sent, disk, flags, ptyThrows: false as boolean, fakeSession, mainWin, MAIN_FRAME, FakeWin, FakeView }
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
  getConsumerLeases: () => S.L.leases,
}))
vi.mock('../../src/main/channel-storage', () => ({
  readJsonFile: (n: string, seed: () => unknown) => (S.disk[n] !== undefined ? JSON.parse(JSON.stringify(S.disk[n])) : seed()),
  peekJsonFile: (n: string) => (S.disk[n] !== undefined ? { kind: 'ok', value: JSON.parse(JSON.stringify(S.disk[n])) } : { kind: 'absent' }),
  quarantinedCopyOf: () => null,
  writeJsonFile: (n: string, v: unknown) => {
    if (S.flags.writeThrows) throw new Error('simulated folder failure before the write')
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

const { wireCodexWebSession } = await import('../../src/main/account-web/codex-web-wiring')
const { ConsumerLeaseRegistry } = await import('../../src/main/providers/core/consumer-leases')
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
const OTHER = 'acct-fedcba9876543210'
/** The PTY check index.ts hands the wiring; a test can make it throw. */
const isCodexPtySession = (sid: string): boolean => {
  if (S.ptyThrows) throw new Error('simulated PTY lookup failure')
  return S.codexPty.has(sid)
}
/** A Codex PTY session's launch takes a lease: owner `<session>:<seq>` (a review: `review:<session>:<seq>`). */
function launch(sid: string, acct: string, kind: 'session' | 'review' = 'session', seq = 1) {
  S.codexPty.add(sid)
  const r = S.L.leases.add(acct, 'codex', { kind, ownerId: kind === 'session' ? `${sid}:${seq}` : `review:${sid}:${seq}`, sessionId: sid })
  if (!r.ok) throw new Error(r.code)
  return r.lease
}
const call = (ch: string, e: unknown, ...args: unknown[]) => S.handlers[ch](e, ...args) as Promise<any>

beforeEach(() => {
  PANE.closeAllAccountPanes()
  CWS._resetCodexWebForTest()
  for (const k of Object.keys(S.handlers)) delete S.handlers[k]
  for (const k of Object.keys(S.sessions)) delete S.sessions[k]
  for (const k of Object.keys(S.disk)) delete S.disk[k]
  S.codexPty.clear()
  S.sent.length = 0
  S.L.leases = new ConsumerLeaseRegistry()
  S.minted.length = 0; S.views.length = 0; S.windows.length = 0; S.trail.length = 0
  S.gates.storage = null
  S.gates.queue.length = 0
  S.flags.writeFails = false
  S.flags.writeThrows = false
  S.reg.accounts = []
  S.ptyThrows = false
  S.L.first = launch('s1', ACCT)
  // As index.ts wires them.
  // Through the wiring index.ts calls, with this test's PTY sessions and leases.
  wireCodexWebSession({ getWindow: () => S.mainWin, isCodexPtySession, leases: () => S.L.leases })
  registerAccountWebHandlers()
  S.reg.accounts = [{ id: ACCT, providerId: 'codex', lifecycle: 'inactive' }, { id: OTHER, providerId: 'codex', lifecycle: 'active' }]
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
    try {
      await sleep(20)
      expect((await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 's1', accountId: ACCT, bounds: BOUNDS })).ok).toBe(false)
      expect((await call(IPC.CODEX_WEB_SIGN_IN, TRUSTED, ACCT)).ok).toBe(false)
      expect(S.windows).toHaveLength(0)
    } finally {
      // Released whatever happened above, so a failure never leaves the clear hanging.
      open(); S.gates.storage = null
    }
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

describe('[host] the clearing bar holds for every clear, overlapping or after an unfinished run', () => {
  const until = async (pred: () => boolean) => { const end = Date.now() + 8000; while (!pred()) { if (Date.now() > end) throw new Error('timed out'); await sleep(5) } }

  it('two overlapping clears of one account: the bar stays until the last one ends', async () => {
    let openFirst!: () => void
    let openSecond!: () => void
    S.gates.queue.push(new Promise<void>((r) => { openFirst = r }), new Promise<void>((r) => { openSecond = r }))
    const first = CWS.clearCodexWebSession(ACCT)
    await until(() => S.gates.waiting === 1)
    const second = CWS.clearCodexWebSession(ACCT)
    await until(() => S.gates.waiting === 2)
    try {
      openSecond()
      await second
      expect(CWS.isCodexWebClearing(ACCT)).toBe(true)
      expect((await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 's1', accountId: ACCT, bounds: BOUNDS })).error).toMatch(/being cleared/)
    } finally {
      openFirst(); openSecond()
      await first
    }
    expect(CWS.isCodexWebClearing(ACCT)).toBe(false)
  })

  it('the wipe after an unfinished sign-in bars a pane until it ends', async () => {
    let open!: () => void
    S.gates.queue.push(new Promise<void>((r) => { open = r }))
    const run = call(IPC.CODEX_WEB_SIGN_IN, TRUSTED, ACCT)
    await until(() => S.windows.length === 1)
    try {
      // The user closes the window: the run ends unfinished and wipes.
      S.windows[0].destroy()
      await until(() => S.gates.waiting === 1)
      expect(CWS.isCodexWebClearing(ACCT)).toBe(true)
      expect((await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 's1', accountId: ACCT, bounds: BOUNDS })).error).toMatch(/being cleared/)
      expect(S.views).toHaveLength(0)
    } finally {
      open()
    }
    expect((await run).state.phase).toBe('failed')
    expect(CWS.isCodexWebClearing(ACCT)).toBe(false)
  })
})

describe('[host] a record write that throws reads as not written', () => {
  const REC = { accountId: ACCT, accountEmail: 'owner@example.com', acquiredAt: 1, expiresAt: null, origin: 'in-app' as const }
  it('save and remove answer false, never throw', () => {
    S.flags.writeThrows = true
    expect(STORE.saveCodexWebSession(REC)).toBe(false)
    S.flags.writeThrows = false
    STORE.saveCodexWebSession(REC)
    S.flags.writeThrows = true
    expect(STORE.removeCodexWebSession(ACCT)).toBe(false)
  })

  it('sign-out over a record that cannot be removed (the write throws) reports it', async () => {
    STORE.saveCodexWebSession(REC)
    S.flags.writeThrows = true
    const r = await call(IPC.CODEX_WEB_SIGN_OUT, TRUSTED, ACCT)
    S.flags.writeThrows = false
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/record could not be removed/) })
    expect(STORE.getCodexWebSession(ACCT)).toBeDefined()
  })
})

describe('[host] a pane is bound to its session\'s current launch, for as long as it lasts', () => {
  it('a review the session runs on another account opens no view of that account', async () => {
    launch('s1', OTHER, 'review')
    expect((await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 's1', accountId: OTHER, bounds: BOUNDS })).error).toMatch(/does not run under/)
    expect(S.minted).not.toContain(`persist:codex-web-${OTHER}`)
  })

  it('after a switch of account the old account no longer opens, the new one does', async () => {
    launch('s1', OTHER, 'session', 2)
    expect((await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 's1', accountId: ACCT, bounds: BOUNDS })).error).toMatch(/does not run under/)
    expect((await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 's1', accountId: OTHER, bounds: BOUNDS })).ok).toBe(true)
  })

  it('the session\'s launch lease released (the CLI exited) closes its pane and tells the renderer', async () => {
    const view = await openPane('s1')
    expect(S.L.first.ownerId).toBe('s1:1')
    S.L.first.release()
    expect(view.webContents.destroyed).toBe(true)
    expect(S.sent).toContainEqual([IPC.ACCOUNT_WEB_PANE_CLOSED, { sessionId: 's1', reason: expect.stringMatching(/no longer runs under/) }])
  })

  it('a switch of account closes the old account\'s pane', async () => {
    const view = await openPane('s1')
    launch('s1', OTHER, 'session', 2)
    expect(view.webContents.destroyed).toBe(true)
  })

  it('a lease change elsewhere leaves a bound pane open', async () => {
    const view = await openPane('s1')
    launch('s2', ACCT)
    launch('s3', OTHER)
    expect(view.webContents.destroyed).toBe(false)
  })
})

describe('[host] a lease check that throws closes the pane (fail closed)', () => {
  it('a PTY check that throws refuses the open, and the next lease change closes the open pane', async () => {
    const view = await openPane('s1')
    S.ptyThrows = true
    expect((await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 's1', accountId: ACCT, bounds: BOUNDS })).ok).toBe(false)
    // Any lease change re-checks; the add itself is never broken by it.
    const r = S.L.leases.add(OTHER, 'codex', { kind: 'operation', ownerId: 'op-2' })
    expect(r.ok).toBe(true)
    expect(view.webContents.destroyed).toBe(true)
  })
})

describe('[host] at start, a Codex web session with no record is wiped', () => {
  it('the wiring sweeps each Codex account with no record, and leaves a recorded one alone', async () => {
    STORE.saveCodexWebSession({ accountId: OTHER, accountEmail: 'owner@example.com', acquiredAt: 1, expiresAt: null, origin: 'in-app' })
    S.reg.accounts = [
      { id: ACCT, providerId: 'codex', lifecycle: 'inactive' },
      { id: OTHER, providerId: 'codex', lifecycle: 'active' },
      { id: 'profile-known1', providerId: 'claude', lifecycle: 'active' },
    ]
    S.trail.length = 0
    wireCodexWebSession({ getWindow: () => S.mainWin, isCodexPtySession, leases: () => S.L.leases, partitionExists: () => true })
    const end = Date.now() + 5000
    while (!S.trail.some((t) => t.startsWith('wipe ')) && Date.now() < end) await sleep(5)
    await sleep(20)
    const wipes = S.trail.filter((t) => t.startsWith('wipe '))
    expect(wipes).toHaveLength(1)
    expect(wipes[0]).toContain(PART)
    expect(STORE.getCodexWebSession(OTHER)).toBeDefined()
    expect(CWS.isCodexWebClearing(ACCT)).toBe(false)
  })
})

describe('[host] a sign-in in the pane whose record cannot be written closes the view saying why (fix pass 9)', () => {
  it('the pane closes with the reason before the wipe, and the renderer is told once', async () => {
    const view = await openPane('s1')
    view.webContents.executeJavaScriptInIsolatedWorld = async () => 'me@example.com'
    S.flags.writeFails = true
    S.sent.length = 0
    S.trail.length = 0
    S.sessions[PART].jar = [{ name: '__Secure-next-auth.session-token', value: 'x', expirationDate: 4102444800 }]
    S.sessions[PART].cookies.listeners[0](null, { name: '__Secure-next-auth.session-token' })
    const end = Date.now() + 5000
    while (!S.trail.some((t) => t.startsWith('wipe ')) && Date.now() < end) await sleep(5)
    await sleep(20)
    expect(view.webContents.destroyed).toBe(true)
    expect(S.trail.find((t) => t.startsWith('wipe '))).toBe(`wipe ${PART} (open views on it: 0, listeners: 0)`)
    const closes = S.sent.filter(([ch, p]) => ch === IPC.ACCOUNT_WEB_PANE_CLOSED && (p as { sessionId?: string }).sessionId === 's1')
    expect(closes).toEqual([[IPC.ACCOUNT_WEB_PANE_CLOSED, { sessionId: 's1', reason: expect.stringMatching(/could not be recorded/) }]])
    expect(STORE.getCodexWebSession(ACCT)).toBeUndefined()
  })
})

describe('[host] sign-out and archive over a store written by a newer build', () => {
  it('sign-out wipes and succeeds, and the archive hook resolves, leaving the newer file as it was', async () => {
    S.disk['codex-web-sessions.json'] = { schemaVersion: 2, sessions: [] }
    try {
      expect(await call(IPC.CODEX_WEB_SIGN_OUT, TRUSTED, ACCT)).toEqual({ ok: true })
      expect(S.trail.some((t) => t.startsWith('wipe '))).toBe(true)
      const release = await CWS.prepareCodexWebArchive(ACCT, 'codex')
      release()
      expect(S.disk['codex-web-sessions.json']).toEqual({ schemaVersion: 2, sessions: [] })
      expect(await call(IPC.CODEX_WEB_STATUS, TRUSTED, ACCT)).toMatchObject({ ok: true, web: { status: 'none', unavailable: expect.stringMatching(/newer version/) } })
      // The pane is inert: refused up front, no partition made, nothing recorded or cleared.
      S.minted.length = 0; S.trail.length = 0
      expect(await call(IPC.CODEX_WEB_PANE_OPEN, TRUSTED, { sessionId: 's1', accountId: ACCT, bounds: BOUNDS })).toMatchObject({ ok: false, error: expect.stringMatching(/newer version/) })
      expect(S.minted).toEqual([])
      expect(S.views).toHaveLength(0)
      expect(S.trail).toEqual([])
    } finally {
      delete S.disk['codex-web-sessions.json']
    }
  })
})
