/**
 * A closed session's browser profile does not outlive it (#371).
 *
 * Each pane runs in `persist:webview-<sessionId>`, which Chromium turns into a
 * profile directory under `sessionData/Partitions/webview-<id>` holding that
 * pane's cookies, localStorage and cache. Nothing ever removed one — session
 * ids are minted per tile and never reused — so every closed tile left a fully
 * populated profile on disk for the life of the install: logged-in cookies for
 * whatever had been browsed, unreachable through the app and invisible in it.
 *
 * The distinction that matters most here is the one the tests end on: this is
 * for a session closed FOR GOOD, and must not fire for the close-and-reopen
 * that a restart or an in-tile account switch performs under the same id.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type Handler = (...args: unknown[]) => unknown

const h = vi.hoisted(() => {
  class FakeWebContents {
    handlers = new Map<string, Handler[]>()
    onceHandlers = new Map<string, Handler[]>()
    loadURL = vi.fn(() => Promise.resolve())
    destroyed = false
    /** Set false to model a WebContents that never confirms destruction. */
    autoDestroy = true
    /** Ticks when 'destroyed' actually fires, so a test can prove the clear
     *  waited for it rather than merely being called after `close()`. */
    destroyedAt = 0
    close = vi.fn(() => {
      // `close()` only INITIATES teardown; the event is what says it is gone.
      if (!this.autoDestroy) return
      setTimeout(() => {
        this.destroyed = true
        this.destroyedAt = FakeWebContents.clock++
        for (const fn of this.onceHandlers.get('destroyed') ?? []) fn()
        this.onceHandlers.delete('destroyed')
      }, 5)
    })
    static clock = 1
    isDestroyed = () => this.destroyed
    getURL = () => 'https://example.com/'
    getTitle = () => 'Example'
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    on(event: string, fn: Handler) {
      const list = this.handlers.get(event) ?? []
      list.push(fn)
      this.handlers.set(event, list)
      return this
    }
    once(event: string, fn: Handler) {
      const list = this.onceHandlers.get(event) ?? []
      list.push(fn)
      this.onceHandlers.set(event, list)
      return this
    }
    setWindowOpenHandler() { /* not under test here */ }
  }
  class FakeView {
    webContents = new FakeWebContents()
    setBounds = vi.fn()
    constructor(public opts: { webPreferences: Record<string, unknown> }) { state.views.push(this) }
  }
  class FakeSession {
    clearedAt = 0
    clearStorageData = vi.fn(() => {
      this.clearedAt = FakeWebContents.clock++
      return Promise.resolve()
    })
    clearCache = vi.fn(() => Promise.resolve())
    setPermissionRequestHandler() {}
    setPermissionCheckHandler() {}
    setDevicePermissionHandler() {}
    on() { return this }
  }
  const state = {
    views: [] as InstanceType<typeof FakeView>[],
    sessions: new Map<string, InstanceType<typeof FakeSession>>(),
    sessionDataDir: '',
    resourcesDir: '',
    FakeView,
    FakeSession,
  }
  return state
})

vi.mock('electron', () => ({
  app: { getPath: (_n: string) => h.sessionDataDir },
  BrowserWindow: class {},
  WebContentsView: h.FakeView,
  net: { request: vi.fn() },
  session: {
    fromPartition: (name: string) => {
      let s = h.sessions.get(name)
      if (!s) { s = new h.FakeSession(); h.sessions.set(name, s) }
      return s
    },
  },
  shell: { openExternal: vi.fn() },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {},
}))

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { openWebview, forgetWebviewProfile } from '../../../src/main/webview-manager'

/** The directory Chromium would have made for this session's partition. */
const partitionDir = (id: string) => path.join(h.sessionDataDir, 'Partitions', `webview-${id}`)
/** Pretend Chromium already created one, with something in it. */
function seedPartition(name: string): string {
  const dir = path.join(h.sessionDataDir, 'Partitions', name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'Cookies'), 'cookie-bytes')
  return dir
}

const parent = () => ({
  isDestroyed: () => false,
  contentView: { addChildView: vi.fn(), removeChildView: vi.fn(), children: [] as unknown[] },
  webContents: { send: vi.fn() },
}) as unknown as import('electron').BrowserWindow

const bounds = { x: 0, y: 0, width: 800, height: 600 }
const partition = (id: string) => `persist:webview-${id}`

beforeEach(() => {
  h.views.length = 0
  h.sessions.clear()
  h.sessionDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-sessiondata-'))
  h.resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-resources-'))
  fs.mkdirSync(path.join(h.sessionDataDir, 'Partitions'), { recursive: true })
})

afterEach(() => {
  try { fs.rmSync(h.sessionDataDir, { recursive: true, force: true }) } catch { /* best effort */ }
})

async function open(id: string) {
  expect(await openWebview(parent(), id, 'https://example.com/', bounds)).toBe(true)
  return { view: h.views.at(-1)!, ses: h.sessions.get(partition(id))! }
}

describe('forgetWebviewProfile', () => {
  it('wipes storage AND cache for the session partition', async () => {
    const { ses } = await open('sess1')
    expect(await forgetWebviewProfile('sess1')).toBe(true)
    expect(ses.clearStorageData).toHaveBeenCalledTimes(1)
    // A wipe that left the HTTP cache still holds page content.
    expect(ses.clearCache).toHaveBeenCalledTimes(1)
  })

  /**
   * #371 review MINOR-3, now actually exercised: the first version asserted
   * `invocationCallOrder`, i.e. that `close()` was CALLED first — which is true
   * however long teardown takes, so it could not detect the race it was named
   * for. The fake now fires 'destroyed' asynchronously, so the assertion is
   * that the clear waited for the EVENT.
   */
  it('waits for the view to be destroyed before clearing, not merely for close() to return', async () => {
    seedPartition('webview-sess1')
    const { view, ses } = await open('sess1')
    await forgetWebviewProfile('sess1')
    expect(view.webContents.close).toHaveBeenCalled()
    expect(view.webContents.destroyed).toBe(true)
    expect(view.webContents.destroyedAt).toBeGreaterThan(0)
    expect(ses.clearedAt).toBeGreaterThan(view.webContents.destroyedAt)
  })

  it('clears anyway when the view never confirms destruction', async () => {
    seedPartition('webview-sess1')
    const { view, ses } = await open('sess1')
    view.webContents.autoDestroy = false // never fires 'destroyed'
    expect(await forgetWebviewProfile('sess1')).toBe(true)
    // The timeout elapses and the jar is still cleared — leaving it is worse.
    expect(ses.clearStorageData).toHaveBeenCalled()
  }, 20_000)

  it('clears only that session, never a sibling still in use', async () => {
    const a = await open('sessA')
    const b = await open('sessB')
    await forgetWebviewProfile('sessA')
    expect(a.ses.clearStorageData).toHaveBeenCalled()
    expect(b.ses.clearStorageData).not.toHaveBeenCalled()
    expect(b.view.webContents.close).not.toHaveBeenCalled()
  })

  it('works for a session whose pane was never opened this run', async () => {
    // The tile is gone but its profile is still on disk from a previous run.
    seedPartition('webview-sessNeverOpened')
    expect(await forgetWebviewProfile('sessNeverOpened')).toBe(true)
    expect(h.sessions.get(partition('sessNeverOpened'))!.clearStorageData).toHaveBeenCalled()
  })

  /**
   * #371 review MINOR-5. `session.fromPartition` CREATES a persist-backed
   * session, so calling this for a tile that never opened a pane — which the
   * launch-gate cancel does — must not leave behind an empty profile
   * directory that nothing would ever clear.
   */
  it('does not materialise a partition for a session that never had one', async () => {
    expect(await forgetWebviewProfile('neverBrowsed')).toBe(true)
    expect(h.sessions.size).toBe(0)
    expect(fs.existsSync(partitionDir('neverBrowsed'))).toBe(false)
  })

  it('removes the directory, not just its contents', async () => {
    const dir = seedPartition('webview-sess1')
    expect(fs.existsSync(dir)).toBe(true)
    await forgetWebviewProfile('sess1')
    // MINOR-2: the doc said "delete" while the code only emptied, so an auditor
    // looking at Partitions/ would conclude the fix never ran.
    expect(fs.existsSync(dir)).toBe(false)
  })
})

/**
 * The rest of the on-delete behaviour: bad input, and the failure modes a tab
 * close must survive.
 */
describe("forgetWebviewProfile — refusals and failure modes", () => {
  it('refuses an id that is not path-safe, and touches no partition', async () => {
    for (const bad of ['a/../../x', 'a\\b', '../etc', 'a b', '', 'x'.repeat(129)]) {
      expect(await forgetWebviewProfile(bad)).toBe(false)
    }
    expect(h.sessions.size).toBe(0)
  })

  it('never throws when the wipe fails — a tab close must not be blocked by it', async () => {
    const { ses } = await open('sess1')
    ses.clearStorageData.mockRejectedValueOnce(new Error('locked'))
    expect(await forgetWebviewProfile('sess1')).toBe(false)
  })

  it('gives up rather than hanging when a wipe never settles', async () => {
    vi.useFakeTimers()
    try {
      const { ses } = await open('sess1')
      ses.clearStorageData.mockReturnValueOnce(new Promise(() => { /* never settles */ }))
      const pending = forgetWebviewProfile('sess1')
      await vi.advanceTimersByTimeAsync(6_000)
      expect(await pending).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
