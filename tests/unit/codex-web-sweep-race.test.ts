// [host] WP2 PR 4, P4.6 (row 58): the start sweep of Codex chatgpt.com web
// sessions with no record, and a sign-in made while it runs.
//
// The REAL sweep, sign-in run, codexWeb IPC channels, account pane and record
// store (over an in-memory channel store). Electron is faked: each partition
// has a cookie jar, a folder that exists once the partition is first used (as
// Electron makes it), and a storage clear a test can hold open. The sign-in
// window's own run (runServiceSignIn) is scripted to sign its partition in,
// so no window opens; everything around it is the app's.
//
// What this pins:
//  - the sweep chooses and reserves its accounts before its first wait: an
//    account it did not choose that signs in while an earlier account's wipe
//    is held keeps its session and its record, through the sign-in window and
//    through the account pane alike, and the earlier account is still cleared;
//  - an account the sweep chose refuses a sign-in and a pane until its own
//    wipe has ended (the bar every clear holds), and both work after it;
//  - the bars are up when the call returns, before anything else runs, and
//    each account's bar lifts as soon as its own wipe ends;
//  - a pane already open on a chosen account closes as it is barred, so no
//    sign-in in it is recorded under the bar.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const S = vi.hoisted(() => {
  type Cookie = { name: string; expirationDate?: number }
  const state = {
    jars: {} as Record<string, Cookie[]>,
    listeners: {} as Record<string, Array<(e: unknown, c: { name: string }) => void>>,
    /** A partition whose storage clear waits on this until it settles. */
    gates: {} as Record<string, Promise<void> | undefined>,
    /** Partitions whose folder exists (made on first use, as Electron does). */
    folders: new Set<string>(),
    sessions: {} as Record<string, unknown>,
    storageClears: [] as string[],
    disk: {} as Record<string, unknown>,
    handlers: {} as Record<string, (e: unknown, ...a: unknown[]) => unknown>,
    views: [] as Array<{ webContents: { destroyed: boolean } }>,
    signInRuns: [] as string[],
    session: (partition: string): unknown => {
      state.folders.add(partition)
      if (state.sessions[partition]) return state.sessions[partition]
      const ses = {
        getUserAgent: () => 'FakeUA (KHTML, like Gecko) App/1 Chrome/1 Electron/1',
        setUserAgent: () => {},
        setPermissionRequestHandler: () => {},
        setPermissionCheckHandler: () => {},
        on: () => {},
        cookies: {
          get: async (filter?: { name?: string }) => {
            const all = state.jars[partition] ?? []
            return typeof filter?.name === 'string' ? all.filter((c) => c.name === filter.name) : [...all]
          },
          on: (_ev: string, fn: (e: unknown, c: { name: string }) => void) => { (state.listeners[partition] ??= []).push(fn) },
          removeListener: (_ev: string, fn: unknown) => { state.listeners[partition] = (state.listeners[partition] ?? []).filter((f) => f !== fn) },
        },
        clearStorageData: async () => {
          if (state.gates[partition]) await state.gates[partition]
          state.storageClears.push(partition)
          delete state.jars[partition]
        },
        clearCache: async () => {},
        clearCodeCaches: async () => {},
      }
      state.sessions[partition] = ses
      return ses
    },
  }
  return state
})

class FakeWebContentsView {
  webContents: Record<string, any>
  constructor() {
    this.webContents = {
      destroyed: false,
      on: () => {},
      setWindowOpenHandler: () => {},
      loadURL: async () => {},
      close() { this.destroyed = true },
      isDestroyed() { return this.destroyed },
      executeJavaScriptInIsolatedWorld: async () => 'b@example.com',
      executeJavaScript: async () => 'b@example.com',
      getURL: () => 'https://chatgpt.com/',
      getTitle: () => 'ChatGPT',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      reloadIgnoringCache: () => {},
    }
    S.views.push(this as never)
  }
  setBounds() {}
}

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { S.handlers[ch] = fn } },
  BrowserWindow: class {},
  WebContentsView: FakeWebContentsView,
  shell: { openExternal: async () => {} },
  session: { fromPartition: (p: string) => S.session(p) },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: () => {}, logError: () => {}, logWarn: () => {} }))
vi.mock('../../src/main/channel-storage', () => ({
  readJsonFile: (n: string, seed: () => unknown) => (S.disk[n] ?? seed()),
  writeJsonFile: (n: string, v: unknown) => { S.disk[n] = JSON.parse(JSON.stringify(v)); return true },
  peekJsonFile: (n: string) => (S.disk[n] !== undefined ? { kind: 'ok', value: S.disk[n] } : { kind: 'absent' }),
  quarantinedCopyOf: () => null,
}))
vi.mock('../../src/main/provider-account-registry', () => ({
  getAccountRegistry: () => ({ current: () => ({ accounts: [A, B].map((id) => ({ id, providerId: 'codex', lifecycle: 'active' })) }) }),
}))
vi.mock('../../src/main/webview-manager', () => ({ closeWebview: () => {} }))
// The sign-in window's own run, scripted: the user signs in, so the session
// cookie lands in the partition and the identity read answers the email.
vi.mock('../../src/main/account-web/in-app-sign-in', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/account-web/in-app-sign-in')>()),
  runServiceSignIn: async (o: { ownerId: string; partition: string }) => {
    S.signInRuns.push(o.ownerId)
    S.session(o.partition)
    S.jars[o.partition] = [TOKEN]
    return { ok: true, email: 'b@example.com', expiresAt: null }
  },
}))

const A = 'acct-0123456789abcdef'
const B = 'acct-fedcba9876543210'
const TOKEN = { name: '__Secure-next-auth.session-token', expirationDate: 4102444800 }

const { IPC } = await import('../../src/shared/ipc-channels')
const { webPartitionForCodexAccount } = await import('../../src/shared/account-web-session')
const CWS = await import('../../src/main/account-web/codex-web-session')
const STORE = await import('../../src/main/account-web/codex-web-store')
const PANE = await import('../../src/main/account-web/account-pane')
const { registerCodexWebHandlers } = await import('../../src/main/ipc/codex-web-handlers')

const PART_A = webPartitionForCodexAccount(A)
const PART_B = webPartitionForCodexAccount(B)
const BOUNDS = { x: 0, y: 0, width: 800, height: 600 }
const BEING_CLEARED = "This account's chatgpt.com sign-in is being cleared. Try again in a moment."

const mainFrame = { name: 'main' }
const win = {
  contentView: { addChildView: () => {}, removeChildView: () => {} },
  webContents: { mainFrame, send: () => {} },
  once: () => {},
  on: () => {},
  isDestroyed: () => false,
}
const TRUSTED = { sender: win.webContents, senderFrame: mainFrame }
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  PANE.closeAllAccountPanes()
  for (const k of ['jars', 'listeners', 'gates', 'sessions', 'disk', 'handlers'] as const) {
    for (const key of Object.keys(S[k])) delete (S[k] as Record<string, unknown>)[key]
  }
  S.folders.clear()
  S.storageClears.length = 0
  S.views.length = 0
  S.signInRuns.length = 0
  CWS._resetCodexWebForTest()
  // As the wiring does at start (codex-web-wiring.ts).
  registerCodexWebHandlers(() => win as never, { sessionRunsUnder: () => true })
  CWS.onCodexWebSessionClosing(PANE.closeCodexAccountPanes)
  CWS.onCodexWebSessionCleared(STORE.removeCodexWebSession)
})

/** Hold a partition's storage clear open; the returned function lets it go. */
function hold(partition: string): () => void {
  let release!: () => void
  S.gates[partition] = new Promise<void>((r) => { release = r })
  return release
}

/** The start sweep as the wiring runs it: the store read once, and a
 *  partition's folder checked as Electron's session data folder holds it. */
function startSweep(): Promise<string[]> {
  return CWS.sweepUnrecordedCodexWebSessions([A, B], STORE.readCodexWebRecordsForSweep(), (id) => S.folders.has(webPartitionForCodexAccount(id)))
}

describe('[host] a sign-in that completes while the start sweep runs is never wiped', () => {
  it('through the sign-in window: its session and its record survive and agree, and the earlier account is still cleared', async () => {
    S.folders.add(PART_A)
    S.jars[PART_A] = [TOKEN]
    const releaseA = hold(PART_A)
    const sweep = startSweep()
    await flush()
    expect(CWS.isCodexWebClearing(A)).toBe(true)
    const res = await S.handlers[IPC.CODEX_WEB_SIGN_IN](TRUSTED, B)
    expect(res).toMatchObject({ ok: true, state: { phase: 'done' } })
    expect(STORE.getCodexWebSession(B)).toMatchObject({ accountId: B, accountEmail: 'b@example.com', origin: 'in-app' })
    releaseA()
    expect(await sweep).toEqual([A])
    expect(S.storageClears).toEqual([PART_A])
    expect(S.jars[PART_A]).toBeUndefined()
    // Both survive, and they agree: a live session with its record.
    expect(S.jars[PART_B]).toEqual([TOKEN])
    expect(STORE.codexWebViewFor(B)).toMatchObject({ accountId: B, status: 'active' })
  })

  it('through the account pane: its session, its record and the pane itself survive, and the earlier account is still cleared', async () => {
    S.folders.add(PART_A)
    const releaseA = hold(PART_A)
    const sweep = startSweep()
    await flush()
    const opened = await S.handlers[IPC.CODEX_WEB_PANE_OPEN](TRUSTED, { sessionId: 'sess-b', accountId: B, bounds: BOUNDS })
    expect(opened).toEqual({ ok: true })
    await flush()
    // The user signs in inside the pane.
    S.jars[PART_B] = [TOKEN]
    for (const fn of S.listeners[PART_B] ?? []) fn(null, { name: TOKEN.name })
    await vi.waitFor(() => expect(STORE.getCodexWebSession(B)).toMatchObject({ accountId: B, accountEmail: 'b@example.com', origin: 'in-pane' }))
    releaseA()
    expect(await sweep).toEqual([A])
    expect(S.storageClears).toEqual([PART_A])
    expect(S.jars[PART_B]).toEqual([TOKEN])
    expect(STORE.codexWebViewFor(B)).toMatchObject({ accountId: B, status: 'active' })
    expect(S.views[0].webContents.destroyed).toBe(false)
    expect(PANE.getAccountPaneState('sess-b')).toMatchObject({ accountId: B, authed: true })
    PANE.closeAccountPane('sess-b')
  })
})

describe('[host] an account the start sweep chose is barred until its own wipe ends', () => {
  it('a sign-in and a pane on it are refused while the sweep runs, start nothing, and both work once its wipe is done', async () => {
    S.folders.add(PART_A)
    S.folders.add(PART_B)
    const releaseA = hold(PART_A)
    const sweep = startSweep()
    // Both barred before the call's first wait: nothing has run yet.
    expect(CWS.isCodexWebClearing(A)).toBe(true)
    expect(CWS.isCodexWebClearing(B)).toBe(true)
    await flush()
    expect(CWS.isCodexWebClearing(B)).toBe(true)
    expect(await S.handlers[IPC.CODEX_WEB_SIGN_IN](TRUSTED, B)).toEqual({ ok: false, error: BEING_CLEARED })
    expect(await S.handlers[IPC.CODEX_WEB_PANE_OPEN](TRUSTED, { sessionId: 'sess-b', accountId: B, bounds: BOUNDS })).toEqual({ ok: false, error: BEING_CLEARED })
    expect(S.signInRuns).toEqual([])
    expect(S.views).toEqual([])
    releaseA()
    expect(await sweep).toEqual([A, B])
    expect(CWS.isCodexWebClearing(B)).toBe(false)
    // After its wipe, a sign-in on it runs and is kept.
    expect(await S.handlers[IPC.CODEX_WEB_SIGN_IN](TRUSTED, B)).toMatchObject({ ok: true, state: { phase: 'done' } })
    expect(S.jars[PART_B]).toEqual([TOKEN])
    expect(STORE.codexWebViewFor(B)).toMatchObject({ accountId: B, status: 'active' })
    expect(await S.handlers[IPC.CODEX_WEB_PANE_OPEN](TRUSTED, { sessionId: 'sess-b', accountId: B, bounds: BOUNDS })).toEqual({ ok: true })
    PANE.closeAccountPane('sess-b')
  })

  it('each chosen account is let go as soon as its own wipe ends, not when the whole sweep does', async () => {
    S.folders.add(PART_A)
    S.folders.add(PART_B)
    const releaseA = hold(PART_A)
    const releaseB = hold(PART_B)
    const sweep = startSweep()
    releaseA()
    await vi.waitFor(() => expect(S.storageClears).toEqual([PART_A]))
    await flush()
    expect(CWS.isCodexWebClearing(A)).toBe(false)
    expect(CWS.isCodexWebClearing(B)).toBe(true)
    releaseB()
    expect(await sweep).toEqual([A, B])
    expect(CWS.isCodexWebClearing(B)).toBe(false)
  })

  it('a pane already open on a chosen account closes as it is barred: a sign-in in it is not recorded, and the wipe leaves no record over an emptied session', async () => {
    S.folders.add(PART_A)
    S.folders.add(PART_B)
    expect(await S.handlers[IPC.CODEX_WEB_PANE_OPEN](TRUSTED, { sessionId: 'sess-b', accountId: B, bounds: BOUNDS })).toEqual({ ok: true })
    await flush()
    const releaseA = hold(PART_A)
    const sweep = startSweep()
    // Closed when the call returns, with its sign-in watch gone.
    expect(S.views[0].webContents.destroyed).toBe(true)
    expect(PANE.getAccountPaneState('sess-b')).toBeNull()
    expect(S.listeners[PART_B] ?? []).toEqual([])
    // A sign-in landing in B's partition while it is barred is not recorded.
    S.jars[PART_B] = [TOKEN]
    for (const fn of S.listeners[PART_B] ?? []) fn(null, { name: TOKEN.name })
    await flush()
    expect(STORE.getCodexWebSession(B)).toBeUndefined()
    releaseA()
    expect(await sweep).toEqual([A, B])
    // The session is gone and so is any record of it: they agree.
    expect(S.jars[PART_B]).toBeUndefined()
    expect(STORE.codexWebViewFor(B)).toMatchObject({ accountId: B, status: 'none' })
  })
})

describe('[host] the start sweep is in place in the same tick as its call', () => {
  it('a sign-in on an account with no partition folder yet, started in the same tick, keeps its session and its record', async () => {
    S.folders.add(PART_A)
    const releaseA = hold(PART_A)
    const sweep = startSweep()
    expect(await S.handlers[IPC.CODEX_WEB_SIGN_IN](TRUSTED, B)).toMatchObject({ ok: true, state: { phase: 'done' } })
    releaseA()
    expect(await sweep).toEqual([A])
    expect(S.jars[PART_B]).toEqual([TOKEN])
    expect(STORE.codexWebViewFor(B)).toMatchObject({ accountId: B, status: 'active' })
  })

  it('a sign-in on a chosen account, started in the same tick, is refused and starts nothing', async () => {
    S.folders.add(PART_A)
    S.folders.add(PART_B)
    const releaseA = hold(PART_A)
    const sweep = startSweep()
    expect(await S.handlers[IPC.CODEX_WEB_SIGN_IN](TRUSTED, B)).toEqual({ ok: false, error: BEING_CLEARED })
    expect(S.signInRuns).toEqual([])
    releaseA()
    expect(await sweep).toEqual([A, B])
  })
})
