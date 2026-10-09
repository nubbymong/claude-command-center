/**
 * The GitHub session context (`github:session:context:get`) answers only the
 * app's own window, its main frame (ipc/trusted-sender.ts). Any other sender or
 * frame, a destroyed window and a call made while there is no window are
 * answered `{ ok: false, data: null }`
 * (the preload's own shape) without reading a session. A refusal writes one log
 * line that carries no part of the request.
 *
 * The sidebar's stores, pollers and schedulers are inert fakes; nothing syncs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { notAppMainFrameEvents } from '../../helpers/app-window-events'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
  logs: [] as string[],
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => { h.handlers.set(ch, fn) },
    on: () => {},
  },
  BrowserWindow: { fromWebContents: () => null },
}))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (...a: unknown[]) => { h.logs.push(a.map(String).join(' ')) },
  logWarn: (...a: unknown[]) => { h.logs.push(a.map(String).join(' ')) },
  logError: (...a: unknown[]) => { h.logs.push(a.map(String).join(' ')) },
  logDebug: () => {}, logTrace: () => {}, setVerboseMode: () => {}, isVerboseMode: () => false, setVerboseBaseline: () => {},
  setTraceMode: () => {}, isTraceMode: () => false, installGlobalErrorHandlers: () => {}, closeDebugLogger: () => {},
}))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => null }))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {} }))
vi.mock('../../../src/main/channel-emitters', () => ({ emitPrMerged: () => {} }))
vi.mock('../../../src/main/active-session', () => ({ setActiveSessionId: () => {} }))
vi.mock('../../../src/main/github/github-config-store', () => ({
  GitHubConfigStore: class { async read() { return null } async write() {} },
}))
vi.mock('../../../src/main/github/cache/cache-store', () => ({
  CacheStore: class { async load() { return { repos: {} } } async save() {} },
}))
vi.mock('../../../src/main/github/session/sync-orchestrator', () => ({
  SyncOrchestrator: class { registerSession() {} unregisterSession() {} setFocus() {} resume() {} pause() {} },
}))
vi.mock('../../../src/main/github/session/notifications-poller', () => ({
  NotificationsPoller: class { syncTo() {} resume() {} pause() {} },
}))
vi.mock('../../../src/main/github/copilot-usage', () => ({
  AiUsageScheduler: class { start() {} getLatest() { return null } async refresh() { return null } },
}))

const { registerGitHubHandlers } = await import('../../../src/main/ipc/github-handlers')
const { IPC } = await import('../../../src/shared/ipc-channels')

const SESSION = 'sess-ctx-1'
const REFUSED = { ok: false, data: null }

const mainFrame = { name: 'main' }
const webContents = { mainFrame, send: vi.fn() }
let destroyed = false
const win = { isDestroyed: () => destroyed, webContents }
/** Read by main's getter at call time: null is "no window" (none yet, or a closed one not re-created). */
let current: typeof win | null = win
const loadSessions = vi.fn(async () => [])

const APP = { sender: webContents, senderFrame: mainFrame }
/** Every frame shape that is not the app window's main frame. */
const FOREIGN = notAppMainFrameEvents(webContents)

const context = (event: unknown) => h.handlers.get(IPC.GITHUB_SESSION_CONTEXT_GET)!(event, SESSION)

beforeEach(async () => {
  h.handlers.clear()
  destroyed = false
  current = win
  registerGitHubHandlers({
    resourcesDir: 'C:/fake/resources',
    getWindow: () => current as never,
    loadSessions,
    saveSessions: async () => {},
  })
  // Registration reads the sessions once in the background; let it settle,
  // so only the context handler's own reads are counted below.
  await new Promise((r) => setTimeout(r, 0))
  loadSessions.mockClear()
  h.logs.length = 0
})

describe('github:session:context:get answers only the app window', () => {
  it('the app window main frame is answered, and the session is read', async () => {
    expect(await context(APP)).toEqual({ ok: true, data: null })
    expect(loadSessions).toHaveBeenCalledTimes(1)
    expect(h.logs).toEqual([])
  })

  it('any other sender or frame is refused, and no session is read', async () => {
    for (const [shape, event] of FOREIGN) {
      expect(await context(event), shape).toEqual(REFUSED)
    }
    expect(loadSessions).not.toHaveBeenCalled()
  })

  it('a destroyed window, or no window at all, is refused, and no session is read', async () => {
    destroyed = true
    expect(await context(APP)).toEqual(REFUSED)
    destroyed = false
    current = null
    expect(await context(APP)).toEqual(REFUSED)
    expect(loadSessions).not.toHaveBeenCalled()
    current = win
    expect(await context(APP)).toEqual({ ok: true, data: null })
  })

  it('a refusal writes one log line, which carries no part of the request', async () => {
    await context(FOREIGN[0][1])
    expect(h.logs.length).toBe(1)
    expect(h.logs[0]).toMatch(/not the app window/)
    expect(h.logs[0]).not.toContain(SESSION)
  })
})
