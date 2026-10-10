// [host] An account stays closed to a sign-in, a view and the artifacts window
// until its earlier clear has really finished; a claude.ai sign-in made while
// the start sweep runs is never wiped; an unfinished in-app sign-in is wiped,
// and its record is forgotten only after a wipe that succeeded.
//
// The REAL sign-in module (the clear, the start sweep, the in-app route around
// its window), the accountWeb IPC channels, the account view, the artifacts
// window and the record store (over an in-memory channel store). Electron is
// faked: each partition has a cookie jar, a folder that exists once the
// partition is first used (as Electron makes it), and a storage clear a test
// can hold open or make fail. The in-app window's own run is scripted to put
// the session cookie in its partition, so no window opens; everything around
// it is the app's.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const S = vi.hoisted(() => {
  type Cookie = { name: string; expirationDate?: number }
  const state = {
    jars: {} as Record<string, Cookie[]>,
    listeners: {} as Record<string, Array<(e: unknown, c: { name: string }) => void>>,
    /** A partition whose storage clear waits on this until it settles. */
    gates: {} as Record<string, Promise<void> | undefined>,
    /** A partition whose HTTP cache clear waits on this until it settles. */
    cacheGates: {} as Record<string, Promise<void> | undefined>,
    /** Partitions whose folder exists (made on first use, as Electron does). */
    folders: new Set<string>(),
    sessions: {} as Record<string, any>,
    storageClears: [] as string[],
    cacheClears: [] as string[],
    codeCacheClears: [] as string[],
    events: [] as string[],
    disk: {} as Record<string, unknown>,
    /** When set, a record write fails (as a full disk would). */
    writeFails: false,
    handlers: {} as Record<string, (e: unknown, ...a: unknown[]) => unknown>,
    views: [] as Array<{ webContents: { destroyed: boolean } }>,
    windows: [] as Array<{ destroyed: boolean }>,
    signInRuns: [] as string[],
    /** What the app window was sent (channel, payload). */
    sent: [] as unknown[][],
    /** What the scripted in-app window ends with: a session, or none (the cookie has landed either way). */
    script: 'complete' as 'complete' | 'incomplete',
    /** When set, the scripted window waits on it before it ends. */
    hold: null as Promise<void> | null,
    session: (partition: string): any => {
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
          state.events.push(`wipe ${partition}`)
          if (state.gates[partition]) await state.gates[partition]
          state.storageClears.push(partition)
          delete state.jars[partition]
        },
        clearCache: async () => {
          if (state.cacheGates[partition]) await state.cacheGates[partition]
          state.cacheClears.push(partition)
        },
        clearCodeCaches: async () => { state.codeCacheClears.push(partition) },
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
      getURL: () => 'https://claude.ai/artifacts',
      getTitle: () => 'Artifacts',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      reloadIgnoringCache: () => {},
    }
    S.views.push(this as never)
  }
  setBounds() {}
}

class FakeArtifactsWindow {
  destroyed = false
  private closed?: () => void
  webContents = {
    on: () => {},
    setWindowOpenHandler: () => {},
    session: { setPermissionRequestHandler: () => {}, on: () => {} },
  }
  constructor() { S.windows.push(this) }
  loadURL = async () => {}
  focus() {}
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.closed?.() }
  on(ev: string, fn: () => void) { if (ev === 'closed') this.closed = fn }
}

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { S.handlers[ch] = fn } },
  BrowserWindow: FakeArtifactsWindow,
  WebContentsView: FakeWebContentsView,
  shell: { openExternal: async () => {} },
  session: { fromPartition: (p: string) => S.session(p) },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: () => {}, logError: () => {}, logWarn: () => {} }))
vi.mock('../../src/main/channel-storage', () => ({
  readJsonFile: (n: string, seed: () => unknown) => (S.disk[n] ?? seed()),
  writeJsonFile: (n: string, v: unknown) => { if (S.writeFails) return false; S.disk[n] = JSON.parse(JSON.stringify(v)); return true },
  peekJsonFile: (n: string) => (S.disk[n] !== undefined ? { kind: 'ok', value: S.disk[n] } : { kind: 'absent' }),
  quarantinedCopyOf: () => null,
}))
vi.mock('../../src/main/account-profiles', () => ({ listProfiles: () => [{ id: A }, { id: B }] }))
vi.mock('../../src/main/account-web/claude-cli-auth', () => ({
  readClaudeCliAuth: async () => ({ authenticated: false }),
  claudeAuthCommand: () => '',
}))
vi.mock('../../src/main/provider-launch-gate', () => ({ providerProbeRefusal: () => null }))
vi.mock('../../src/main/data-paths', () => ({ getDataDirectory: () => '/data' }))
vi.mock('../../src/main/webview-manager', () => ({ closeWebview: () => {} }))
// The in-app window's own run, scripted: the user signs in, so the session
// cookie lands in the partition; the run then ends with the session or, as
// after a Cancel, without it.
vi.mock('../../src/main/account-web/in-app-sign-in', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/account-web/in-app-sign-in')>()),
  runInAppSignIn: async (o: { profileId: string; partition: string }) => {
    S.signInRuns.push(o.profileId)
    S.session(o.partition)
    S.jars[o.partition] = [SK]
    if (S.hold) await S.hold
    if (S.script === 'incomplete') return { ok: false, cancelled: true, error: 'Sign-in cancelled.' }
    return { ok: true, session: { profileId: o.profileId, accountEmail: 'b@example.com', acquiredAt: Date.now(), expiresAt: null, origin: 'in-app' } }
  },
}))

const A = 'profile-aaa111'
const B = 'profile-bbb222'
const SK = { name: 'sessionKey', expirationDate: 4102444800 }

const { IPC } = await import('../../src/shared/ipc-channels')
const { webPartitionForProfile } = await import('../../src/shared/account-web-session')
const SIGN_IN = await import('../../src/main/account-web/sign-in')
const STORE = await import('../../src/main/account-web/session-store')
const PANE = await import('../../src/main/account-web/account-pane')
const ART = await import('../../src/main/account-web/artifacts')
const REVOKE = await import('../../src/main/account-web/partition-revocation')
const { registerAccountWebHandlers } = await import('../../src/main/ipc/account-web-handlers')

const PART_A = webPartitionForProfile(A)
const PART_B = webPartitionForProfile(B)
const BOUNDS = { x: 0, y: 0, width: 800, height: 600 }
const BEING_CLEARED = "This account's claude.ai sign-in is being cleared. Try again in a moment."

const mainFrame = { name: 'main' }
const win = {
  contentView: { addChildView: () => {}, removeChildView: () => {} },
  webContents: { mainFrame, send: (...a: unknown[]) => { S.sent.push(a) } },
  once: () => {},
  on: () => {},
  isDestroyed: () => false,
}
const TRUSTED = { sender: win.webContents, senderFrame: mainFrame }
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  PANE.closeAllAccountPanes()
  for (const k of ['jars', 'listeners', 'gates', 'cacheGates', 'sessions', 'disk', 'handlers'] as const) {
    for (const key of Object.keys(S[k])) delete (S[k] as Record<string, unknown>)[key]
  }
  S.folders.clear()
  S.storageClears.length = 0
  S.cacheClears.length = 0
  S.codeCacheClears.length = 0
  S.events.length = 0
  S.views.length = 0
  S.windows.length = 0
  S.signInRuns.length = 0
  S.sent.length = 0
  S.script = 'complete'
  S.hold = null
  S.writeFails = false
  ART.closeArtifacts(A)
  ART.closeArtifacts(B)
  SIGN_IN._resetClaudeWebForTest()
  REVOKE._resetPartitionRevocationForTest()
  // As the app wires them at start.
  registerAccountWebHandlers(() => win as never)
  REVOKE.onPartitionRevoked(STORE.removeWebSession)
  REVOKE.onPartitionRevoked(PANE.closeAccountPanesForProfile)
  SIGN_IN.onClaudeWebSessionClosing((id: string) => { S.events.push(`close ${id}`) })
  SIGN_IN.onClaudeWebSessionClosing(PANE.closeAccountPanesForProfile)
  SIGN_IN.onClaudeWebSessionClosing(ART.closeArtifacts)
})

/** Hold a partition's storage clear open; the returned function lets it go. */
function hold(partition: string): () => void {
  let release!: () => void
  S.gates[partition] = new Promise<void>((r) => { release = r })
  return release
}

/** Hold a partition's storage clear open; the returned function makes it fail. */
function holdToFail(partition: string): () => void {
  let fail!: () => void
  S.gates[partition] = new Promise<void>((_, reject) => { fail = () => reject(new Error('storage clear failed')) })
  return fail
}

/** The start sweep as the app runs it: the store read once, and a partition's
 *  folder checked as Electron's session data folder holds it. */
function startSweep(): Promise<string[]> {
  return SIGN_IN.sweepUnrecordedClaudeWebSessions([A, B], STORE.readClaudeWebRecordsForSweep(), (id: string) => S.folders.has(webPartitionForProfile(id)))
}

const signIn = (id: string) => S.handlers[IPC.ACCOUNT_WEB_SIGN_IN](TRUSTED, id) as Promise<{ ok: boolean; state?: { phase: string; error?: string } }>
const openPane = (sessionId: string, profileId: string) => S.handlers[IPC.ACCOUNT_WEB_PANE_OPEN](TRUSTED, { sessionId, profileId, bounds: BOUNDS }) as Promise<{ ok: boolean; error?: string }>
const openArtifacts = (id: string) => S.handlers[IPC.ACCOUNT_WEB_OPEN_ARTIFACTS](TRUSTED, id) as Promise<{ ok: boolean; error?: string }>
const signOut = (id: string) => S.handlers[IPC.ACCOUNT_WEB_SIGN_OUT](TRUSTED, id) as Promise<{ ok: boolean; error?: string }>
const refusedWhileClearing = { ok: true, state: { phase: 'failed', error: BEING_CLEARED } }

describe('[host] a sign-in that completes while the start sweep runs is never wiped', () => {
  it('through the sign-in window: its session and its record survive and agree, and the earlier account is still cleared', async () => {
    S.folders.add(PART_A)
    S.jars[PART_A] = [SK]
    const releaseA = hold(PART_A)
    const sweep = startSweep()
    await flush()
    expect(SIGN_IN.isClaudeWebClearing(A)).toBe(true)
    expect(await signIn(B)).toMatchObject({ ok: true, state: { phase: 'done' } })
    expect(STORE.getWebSession(B)).toMatchObject({ profileId: B, accountEmail: 'b@example.com', origin: 'in-app' })
    releaseA()
    expect(await sweep).toEqual([A])
    expect(S.storageClears).toEqual([PART_A])
    expect(S.jars[PART_A]).toBeUndefined()
    expect(S.jars[PART_B]).toEqual([SK])
    expect(STORE.viewFor(B)).toMatchObject({ profileId: B, status: 'active' })
  })

  it('through the account view: its session, its record and the view itself survive, and the earlier account is still cleared', async () => {
    S.folders.add(PART_A)
    const releaseA = hold(PART_A)
    const sweep = startSweep()
    await flush()
    expect(await openPane('sess-b', B)).toEqual({ ok: true })
    await flush()
    S.jars[PART_B] = [SK]
    for (const fn of S.listeners[PART_B] ?? []) fn(null, { name: SK.name })
    await vi.waitFor(() => expect(STORE.getWebSession(B)).toMatchObject({ profileId: B, accountEmail: 'b@example.com', origin: 'in-pane' }))
    releaseA()
    expect(await sweep).toEqual([A])
    expect(S.storageClears).toEqual([PART_A])
    expect(S.jars[PART_B]).toEqual([SK])
    expect(STORE.viewFor(B)).toMatchObject({ profileId: B, status: 'active' })
    expect(S.views[0].webContents.destroyed).toBe(false)
    PANE.closeAccountPane('sess-b')
  })

  it('the account of a sign-in in flight is skipped: its session and its record survive', async () => {
    S.folders.add(PART_A)
    let release!: () => void
    S.hold = new Promise<void>((r) => { release = r })
    const running = signIn(A)
    await flush()
    expect(S.signInRuns).toEqual([A])
    const sweep = startSweep()
    expect(SIGN_IN.isClaudeWebClearing(A)).toBe(false)
    release()
    expect(await running).toMatchObject({ ok: true, state: { phase: 'done' } })
    expect(await sweep).toEqual([])
    expect(S.jars[PART_A]).toEqual([SK])
    expect(STORE.viewFor(A)).toMatchObject({ profileId: A, status: 'active' })
  })
})

describe('[host] an account the start sweep chose is closed to a sign-in, a view and the artifacts window until its own wipe ends', () => {
  it('each is refused while the sweep runs and starts nothing, and all work once its wipe is done', async () => {
    S.folders.add(PART_A)
    S.folders.add(PART_B)
    const releaseA = hold(PART_A)
    const sweep = startSweep()
    // Both barred before the call's first wait: nothing has run yet.
    expect(SIGN_IN.isClaudeWebClearing(A)).toBe(true)
    expect(SIGN_IN.isClaudeWebClearing(B)).toBe(true)
    await flush()
    expect(await signIn(B)).toMatchObject(refusedWhileClearing)
    expect(await openPane('sess-b', B)).toEqual({ ok: false, error: BEING_CLEARED })
    expect(await openArtifacts(B)).toEqual({ ok: false, error: BEING_CLEARED })
    expect(S.signInRuns).toEqual([])
    expect(S.views).toEqual([])
    expect(S.windows).toEqual([])
    releaseA()
    expect(await sweep).toEqual([A, B])
    expect(SIGN_IN.isClaudeWebClearing(B)).toBe(false)
    expect(await signIn(B)).toMatchObject({ ok: true, state: { phase: 'done' } })
    expect(S.jars[PART_B]).toEqual([SK])
    expect(STORE.viewFor(B)).toMatchObject({ profileId: B, status: 'active' })
    expect(await openPane('sess-b', B)).toEqual({ ok: true })
    expect(await openArtifacts(B)).toEqual({ ok: true })
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
    expect(SIGN_IN.isClaudeWebClearing(A)).toBe(false)
    expect(SIGN_IN.isClaudeWebClearing(B)).toBe(true)
    releaseB()
    expect(await sweep).toEqual([A, B])
    expect(SIGN_IN.isClaudeWebClearing(B)).toBe(false)
  })

  it('a view already open on a chosen account closes as it is barred: a sign-in in it is not recorded, and the wipe leaves no record over an emptied session', async () => {
    S.folders.add(PART_A)
    S.folders.add(PART_B)
    expect(await openPane('sess-b', B)).toEqual({ ok: true })
    await flush()
    const releaseA = hold(PART_A)
    const sweep = startSweep()
    expect(S.views[0].webContents.destroyed).toBe(true)
    expect(PANE.getAccountPaneState('sess-b')).toBeNull()
    expect(S.listeners[PART_B] ?? []).toEqual([])
    S.jars[PART_B] = [SK]
    for (const fn of S.listeners[PART_B] ?? []) fn(null, { name: SK.name })
    await flush()
    expect(STORE.getWebSession(B)).toBeUndefined()
    releaseA()
    expect(await sweep).toEqual([A, B])
    expect(S.jars[PART_B]).toBeUndefined()
    expect(STORE.viewFor(B)).toMatchObject({ profileId: B, status: 'none' })
  })
})

describe('[host] an account stays closed until its storage clear actually ends', () => {
  // The wait for a storage clear is bounded, but the clear itself goes on when
  // that wait gives up; with fake timers, running the pending timers ends the wait.
  const timers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

  it('a sign-out whose clear outlasts its time limit keeps the account closed until it ends, then a sign-in after it keeps its session', async () => {
    S.jars[PART_A] = [SK]
    const releaseA = hold(PART_A)
    timers()
    try {
      const out = signOut(A)
      await vi.runOnlyPendingTimersAsync()
      expect(await out).toMatchObject({ ok: false, error: expect.stringMatching(/timed out/) })
      expect(SIGN_IN.isClaudeWebClearing(A)).toBe(true)
      expect(await signIn(A)).toMatchObject(refusedWhileClearing)
      expect(await openPane('sess-a', A)).toEqual({ ok: false, error: BEING_CLEARED })
      expect(S.signInRuns).toEqual([])
      releaseA()
      await vi.advanceTimersByTimeAsync(0)
      expect(SIGN_IN.isClaudeWebClearing(A)).toBe(false)
      expect(S.storageClears).toEqual([PART_A])
      expect(await signIn(A)).toMatchObject({ ok: true, state: { phase: 'done' } })
      expect(S.jars[PART_A]).toEqual([SK])
      expect(STORE.viewFor(A)).toMatchObject({ profileId: A, status: 'active' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a clear that outlasts its time limit and then fails lifts the bar when it fails', async () => {
    const failA = holdToFail(PART_A)
    timers()
    try {
      const out = signOut(A)
      await vi.runOnlyPendingTimersAsync()
      expect(await out).toMatchObject({ ok: false })
      expect(SIGN_IN.isClaudeWebClearing(A)).toBe(true)
      failA()
      await vi.advanceTimersByTimeAsync(0)
      expect(SIGN_IN.isClaudeWebClearing(A)).toBe(false)
      expect(await signIn(A)).toMatchObject({ ok: true, state: { phase: 'done' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a clear that fails at once lifts its bar at once', async () => {
    const failA = holdToFail(PART_A)
    const out = SIGN_IN.clearWebSession(A).then(() => 'cleared', (err: Error) => err.message)
    failA()
    expect(await out).toMatch(/storage clear failed/)
    expect(SIGN_IN.isClaudeWebClearing(A)).toBe(false)
  })

  it('overlapping clears: each lifts only its own share, once, so the account stays closed until the last clear actually ends', async () => {
    const releaseFirst = hold(PART_A)
    timers()
    try {
      const first = SIGN_IN.clearWebSession(A).then(() => 'cleared', (err: Error) => err.message)
      await vi.runOnlyPendingTimersAsync()
      expect(await first).toMatch(/timed out/)
      expect(SIGN_IN.isClaudeWebClearing(A)).toBe(true)
      const releaseSecond = hold(PART_A)
      const second = SIGN_IN.clearWebSession(A)
      releaseSecond()
      await second
      expect(SIGN_IN.isClaudeWebClearing(A)).toBe(true)
      expect(await signIn(A)).toMatchObject(refusedWhileClearing)
      releaseFirst()
      await vi.advanceTimersByTimeAsync(0)
      expect(SIGN_IN.isClaudeWebClearing(A)).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("the start sweep's clear that outlasts its time limit keeps the account closed until it ends", async () => {
    S.folders.add(PART_A)
    const releaseA = hold(PART_A)
    timers()
    try {
      const sweep = startSweep()
      await vi.runOnlyPendingTimersAsync()
      expect(await sweep).toEqual([])
      expect(SIGN_IN.isClaudeWebClearing(A)).toBe(true)
      expect(await signIn(A)).toMatchObject(refusedWhileClearing)
      releaseA()
      await vi.advanceTimersByTimeAsync(0)
      expect(SIGN_IN.isClaudeWebClearing(A)).toBe(false)
      expect(await signIn(A)).toMatchObject({ ok: true, state: { phase: 'done' } })
      expect(S.jars[PART_A]).toEqual([SK])
    } finally {
      vi.useRealTimers()
    }
  })

  it("an unfinished in-app sign-in whose clear outlasts its time limit keeps the account closed until it ends", async () => {
    S.script = 'incomplete'
    const releaseA = hold(PART_A)
    timers()
    try {
      const run = signIn(A)
      await vi.runOnlyPendingTimersAsync()
      expect(await run).toMatchObject({ ok: true, state: { phase: 'failed' } })
      expect(SIGN_IN.isClaudeWebClearing(A)).toBe(true)
      S.script = 'complete'
      expect(await signIn(A)).toMatchObject(refusedWhileClearing)
      releaseA()
      await vi.advanceTimersByTimeAsync(0)
      expect(SIGN_IN.isClaudeWebClearing(A)).toBe(false)
      expect(await signIn(A)).toMatchObject({ ok: true, state: { phase: 'done' } })
      expect(S.jars[PART_A]).toEqual([SK])
    } finally {
      vi.useRealTimers()
    }
  })

  it('the record is forgotten while the account is still closed', async () => {
    const barred: boolean[] = []
    REVOKE.onPartitionRevoked((id) => { barred.push(SIGN_IN.isClaudeWebClearing(id)) })
    await SIGN_IN.clearWebSession(A)
    expect(barred).toEqual([true])
  })
})

describe('[host] an unfinished in-app sign-in is wiped, and its record forgotten only after a wipe that succeeded', () => {
  const recorded = () => STORE.saveWebSession({ profileId: A, accountEmail: 'b@example.com', acquiredAt: 1, expiresAt: null, origin: 'in-pane' })

  it('a wipe that succeeds empties the partition, its HTTP and code caches, closes its views first, and forgets the record', async () => {
    expect(recorded()).toBe(true)
    S.script = 'incomplete'
    expect(await signIn(A)).toMatchObject({ ok: true, state: { phase: 'failed' } })
    expect(S.jars[PART_A]).toBeUndefined()
    expect(STORE.getWebSession(A)).toBeUndefined()
    await vi.waitFor(() => expect(S.codeCacheClears).toEqual([PART_A]))
    expect(S.cacheClears).toEqual([PART_A])
    const closedAt = S.events.indexOf(`close ${A}`)
    expect(closedAt).toBeGreaterThanOrEqual(0)
    expect(closedAt).toBeLessThan(S.events.indexOf(`wipe ${PART_A}`))
  })

  it('the run ends once its session is gone: a cache clear still running keeps no next sign-in waiting, and still ends', async () => {
    expect(recorded()).toBe(true)
    S.script = 'incomplete'
    let releaseCache!: () => void
    S.cacheGates[PART_A] = new Promise<void>((r) => { releaseCache = r })
    try {
      let ended = false
      const run = signIn(A).then((r) => { ended = true; return r })
      await vi.waitFor(() => expect(ended).toBe(true), { timeout: 2_000 })
      expect(await run).toMatchObject({ ok: true, state: { phase: 'failed' } })
      expect(S.jars[PART_A]).toBeUndefined()
      expect(STORE.getWebSession(A)).toBeUndefined()
      expect(S.cacheClears).toEqual([])
      S.script = 'complete'
      expect(await signIn(B)).toMatchObject({ ok: true, state: { phase: 'done' } })
    } finally {
      releaseCache()
    }
    await vi.waitFor(() => expect(S.codeCacheClears).toContain(PART_A))
    expect(S.cacheClears).toContain(PART_A)
  })

  it('a wipe that fails keeps the record, so the account can still be signed out', async () => {
    expect(recorded()).toBe(true)
    S.script = 'incomplete'
    const failA = holdToFail(PART_A)
    const run = signIn(A)
    await flush()
    failA()
    expect(await run).toMatchObject({ ok: true, state: { phase: 'failed' } })
    expect(STORE.getWebSession(A)).toMatchObject({ profileId: A })
    expect(SIGN_IN.isClaudeWebClearing(A)).toBe(false)
  })
})

describe('[host] a sign-in made in the account view whose record cannot be written is cleared, never left live without one', () => {
  it('the view closes saying why, and the session is wiped', async () => {
    expect(await openPane('sess-a', A)).toEqual({ ok: true })
    await flush()
    S.writeFails = true
    S.jars[PART_A] = [SK]
    for (const fn of S.listeners[PART_A] ?? []) fn(null, { name: SK.name })
    await vi.waitFor(() => expect(S.storageClears).toEqual([PART_A]))
    await vi.waitFor(() => expect(SIGN_IN.isClaudeWebClearing(A)).toBe(false))
    expect(S.jars[PART_A]).toBeUndefined()
    expect(STORE.getWebSession(A)).toBeUndefined()
    expect(S.views[0].webContents.destroyed).toBe(true)
    const closes = S.sent.filter((m) => m[0] === IPC.ACCOUNT_WEB_PANE_CLOSED)
    expect(closes[0]).toEqual([IPC.ACCOUNT_WEB_PANE_CLOSED, { sessionId: 'sess-a', reason: expect.stringMatching(/could not be recorded/) }])
  })

  it('a record that is written leaves the session alone', async () => {
    expect(await openPane('sess-a', A)).toEqual({ ok: true })
    await flush()
    S.jars[PART_A] = [SK]
    for (const fn of S.listeners[PART_A] ?? []) fn(null, { name: SK.name })
    await vi.waitFor(() => expect(STORE.getWebSession(A)).toMatchObject({ profileId: A, origin: 'in-pane' }))
    expect(S.storageClears).toEqual([])
    expect(S.views[0].webContents.destroyed).toBe(false)
    PANE.closeAccountPane('sess-a')
  })
})

describe('[host] over a record store written by a newer build, the account view stays shut and nothing is cleared', () => {
  it('the view is refused with the reason, the store is left as it is, and the start sweep stands down', async () => {
    const newer = { schemaVersion: 5, sessions: [{ profileId: A, accountEmail: 'b@example.com', acquiredAt: 1, expiresAt: null, origin: 'in-app' }] }
    S.disk['account-web-sessions.json'] = newer
    S.folders.add(PART_A)
    S.jars[PART_A] = [SK]
    expect(await openPane('sess-a', A)).toEqual({ ok: false, error: STORE.NEWER_WEB_STORE_REASON })
    expect(S.views).toEqual([])
    expect(await startSweep()).toEqual([])
    expect(S.storageClears).toEqual([])
    expect(S.jars[PART_A]).toEqual([SK])
    expect(S.disk['account-web-sessions.json']).toEqual(newer)
  })
})

describe('[host] a finished sign-in whose record cannot be kept reads failed, never done', () => {
  it("only that account's finished run is marked failed, with the reason", async () => {
    expect(await signIn(A)).toMatchObject({ ok: true, state: { phase: 'done' } })
    SIGN_IN.discardSignInRun(B, 'not this account')
    expect(SIGN_IN.getSignInState()).toMatchObject({ phase: 'done', profileId: A })
    SIGN_IN.discardSignInRun(A, 'The sign-in finished, but it could not be recorded, so it was cleared. Try again.')
    expect(SIGN_IN.getSignInState()).toMatchObject({ phase: 'failed', profileId: A, error: expect.stringMatching(/could not be recorded/) })
    // A run that did not finish is left as it is.
    SIGN_IN.discardSignInRun(A, 'again')
    expect(SIGN_IN.getSignInState()).toMatchObject({ phase: 'failed', error: expect.stringMatching(/could not be recorded/) })
  })
})

describe("[host] a sign-in through the app window's channel is kept only with its record", () => {
  it('over a record store written by a newer build, the sign-in is refused with the reason before anything starts, and the store is left as it is', async () => {
    const newer = { schemaVersion: 5, sessions: [{ profileId: B, accountEmail: 'b@example.com', acquiredAt: 1, expiresAt: null, origin: 'in-app' }] }
    S.disk['account-web-sessions.json'] = newer
    const before = JSON.stringify(S.disk['account-web-sessions.json'])
    expect(await signIn(A)).toEqual({ ok: false, error: STORE.NEWER_WEB_STORE_REASON })
    // No run, no window, no session made, nothing cleared.
    expect(S.signInRuns).toEqual([])
    expect(S.views).toEqual([])
    expect(S.windows).toEqual([])
    expect(S.jars[PART_A]).toBeUndefined()
    expect(S.storageClears).toEqual([])
    expect(SIGN_IN.getSignInState()).toMatchObject({ phase: 'idle' })
    expect(JSON.stringify(S.disk['account-web-sessions.json'])).toBe(before)
  })

  it('a finished sign-in whose record cannot be written is cleared and reads failed, and a sign-in after it is kept', async () => {
    S.writeFails = true
    expect(await signIn(A)).toEqual({ ok: true, state: { phase: 'failed', profileId: A, error: expect.stringMatching(/could not be recorded/) } })
    expect(S.signInRuns).toEqual([A])
    // Its views closed first, then its session wiped; no record either way.
    expect(S.storageClears).toEqual([PART_A])
    expect(S.jars[PART_A]).toBeUndefined()
    expect(S.events.indexOf(`close ${A}`)).toBeGreaterThanOrEqual(0)
    expect(S.events.indexOf(`close ${A}`)).toBeLessThan(S.events.indexOf(`wipe ${PART_A}`))
    expect(STORE.getWebSession(A)).toBeUndefined()
    expect(SIGN_IN.getSignInState()).toMatchObject({ phase: 'failed', profileId: A, error: expect.stringMatching(/could not be recorded/) })
    expect(SIGN_IN.isClaudeWebClearing(A)).toBe(false)
    S.writeFails = false
    expect(await signIn(A)).toMatchObject({ ok: true, state: { phase: 'done' } })
    expect(S.jars[PART_A]).toEqual([SK])
    expect(STORE.viewFor(A)).toMatchObject({ profileId: A, status: 'active' })
  })
})
