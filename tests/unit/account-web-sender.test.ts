/**
 * The claude.ai sign-in handlers (`accountWeb:*`) answer only the app's own
 * window, its main frame (ipc/trusted-sender.ts).
 *
 * Every registered channel is driven from the handler map itself, so a channel
 * added later without a row below fails the coverage case instead of going
 * unchecked. For each one:
 *   (a) the app window's main frame is answered, and the channel does its work;
 *   (b) another webContents is refused, and nothing it could act on is touched;
 *   (c) the app window's own webContents from a sub-frame (or no frame) is refused;
 *   (d) a destroyed window, or no window at all, is refused.
 * A refusal writes one log line that carries no part of the request.
 *
 * The pane and the artifacts window attach to the app window itself, never to
 * whichever window the request came from.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mainIndexSource, notAppMainFrameEvents } from '../helpers/app-window-events'

vi.mock('../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>()
/** What `BrowserWindow.fromWebContents` answers: deliberately NOT the app window. */
const elsewhere = { id: 'another-window' }
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  BrowserWindow: { fromWebContents: () => elsewhere },
}))

const logs = vi.hoisted(() => ({ lines: [] as string[] }))
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: (...a: unknown[]) => { logs.lines.push(a.map(String).join(' ')) },
  logWarn: (...a: unknown[]) => { logs.lines.push(a.map(String).join(' ')) },
  logError: (...a: unknown[]) => { logs.lines.push(a.map(String).join(' ')) },
  logDebug: () => {}, logTrace: () => {}, setVerboseMode: () => {}, isVerboseMode: () => false, setVerboseBaseline: () => {},
  setTraceMode: () => {}, isTraceMode: () => false, installGlobalErrorHandlers: () => {}, closeDebugLogger: () => {},
}))
vi.mock('../../src/main/data-paths', () => ({ getDataDirectory: () => 'C:/fake/data' }))

/** Everything a handler could act on. A refused request touches none of it. */
const acted = vi.hoisted(() => ({
  runSignIn: vi.fn(async () => ({ phase: 'idle' })),
  cancelSignIn: vi.fn(),
  clearWebSession: vi.fn(async () => {}),
  getSignInState: vi.fn(() => ({ phase: 'idle' })),
  detectAuthBrowsers: vi.fn(() => []),
  openArtifacts: vi.fn(() => ({ ok: true })),
  closeArtifacts: vi.fn(),
  readClaudeCliAuth: vi.fn(async () => ({ authenticated: false })),
  claudeAuthCommand: vi.fn(() => 'claude auth login'),
  viewFor: vi.fn(() => ({ status: 'none' })),
  saveWebSession: vi.fn(),
  removeWebSession: vi.fn(),
  setAuthMethod: vi.fn(),
  setAuthBrowser: vi.fn(),
  setWebSignInMode: vi.fn(),
  getAuthMethod: vi.fn(() => 'claudeai'),
  getAuthBrowser: vi.fn(() => 'edge'),
  getWebSignInMode: vi.fn(() => 'auto'),
  openAccountPane: vi.fn(() => ({ ok: true })),
  closeAccountPane: vi.fn(() => true),
  closeAccountPanesForProfile: vi.fn(),
  getAccountPaneState: vi.fn(() => ({ sessionId: 's1' })),
  reloadAccountPane: vi.fn(),
  setAccountPaneBounds: vi.fn(),
  setAccountPaneVisible: vi.fn(),
  closeWebview: vi.fn(),
  listProfiles: vi.fn(() => [{ id: 'profile-known1' }]),
}))
vi.mock('../../src/main/account-web/sign-in', () => ({
  runSignIn: acted.runSignIn, cancelSignIn: acted.cancelSignIn, clearWebSession: acted.clearWebSession,
  getSignInState: acted.getSignInState, detectAuthBrowsers: acted.detectAuthBrowsers,
}))
vi.mock('../../src/main/account-web/artifacts', () => ({ openArtifacts: acted.openArtifacts, closeArtifacts: acted.closeArtifacts }))
vi.mock('../../src/main/account-web/claude-cli-auth', () => ({ readClaudeCliAuth: acted.readClaudeCliAuth, claudeAuthCommand: acted.claudeAuthCommand }))
vi.mock('../../src/main/account-web/session-store', () => ({
  viewFor: acted.viewFor, saveWebSession: acted.saveWebSession, removeWebSession: acted.removeWebSession,
  setAuthMethod: acted.setAuthMethod, setAuthBrowser: acted.setAuthBrowser, setWebSignInMode: acted.setWebSignInMode,
  getAuthMethod: acted.getAuthMethod, getAuthBrowser: acted.getAuthBrowser, getWebSignInMode: acted.getWebSignInMode,
}))
vi.mock('../../src/main/account-web/account-pane', () => ({
  openAccountPane: acted.openAccountPane, closeAccountPane: acted.closeAccountPane,
  closeAccountPanesForProfile: acted.closeAccountPanesForProfile, getAccountPaneState: acted.getAccountPaneState,
  reloadAccountPane: acted.reloadAccountPane, setAccountPaneBounds: acted.setAccountPaneBounds,
  setAccountPaneVisible: acted.setAccountPaneVisible,
}))
vi.mock('../../src/main/account-profiles', () => ({ listProfiles: acted.listProfiles }))
vi.mock('../../src/main/webview-manager', () => ({ closeWebview: acted.closeWebview }))

const { registerAccountWebHandlers } = await import('../../src/main/ipc/account-web-handlers')
const { IPC } = await import('../../src/shared/ipc-channels')

const PROFILE = 'profile-known1'
const BOUNDS = { x: 0, y: 0, width: 100, height: 100 }
const REFUSED = { ok: false, error: 'refused: not the app window' }

/** One row per channel: a valid request, and the work it does once answered. */
const ROWS: Record<string, { args: unknown[]; does: () => unknown }> = {
  [IPC.ACCOUNT_WEB_WEB_STATUS]: { args: [PROFILE], does: () => acted.viewFor },
  [IPC.ACCOUNT_WEB_STATUS]: { args: [PROFILE], does: () => acted.readClaudeCliAuth },
  [IPC.ACCOUNT_WEB_SIGN_IN]: { args: [PROFILE], does: () => acted.runSignIn },
  [IPC.ACCOUNT_WEB_SIGN_IN_STATE]: { args: [], does: () => acted.getSignInState },
  [IPC.ACCOUNT_WEB_CANCEL]: { args: [PROFILE], does: () => acted.cancelSignIn },
  [IPC.ACCOUNT_WEB_SIGN_OUT]: { args: [PROFILE], does: () => acted.clearWebSession },
  [IPC.ACCOUNT_WEB_SET_AUTH_METHOD]: { args: [{ profileId: PROFILE, method: 'sso' }], does: () => acted.setAuthMethod },
  [IPC.ACCOUNT_WEB_SET_AUTH_BROWSER]: { args: [{ profileId: PROFILE, browser: 'chrome' }], does: () => acted.setAuthBrowser },
  [IPC.ACCOUNT_WEB_OPEN_ARTIFACTS]: { args: [PROFILE], does: () => acted.openArtifacts },
  [IPC.ACCOUNT_WEB_SET_SIGN_IN_MODE]: { args: [{ profileId: PROFILE, mode: 'internal-pane' }], does: () => acted.setWebSignInMode },
  [IPC.ACCOUNT_WEB_PANE_OPEN]: { args: [{ sessionId: 's1', profileId: PROFILE, bounds: BOUNDS }], does: () => acted.openAccountPane },
  [IPC.ACCOUNT_WEB_PANE_CLOSE]: { args: ['s1'], does: () => acted.closeAccountPane },
  [IPC.ACCOUNT_WEB_PANE_BOUNDS]: { args: [{ sessionId: 's1', bounds: BOUNDS }], does: () => acted.setAccountPaneBounds },
  [IPC.ACCOUNT_WEB_PANE_VISIBLE]: { args: [{ sessionId: 's1', visible: false }], does: () => acted.setAccountPaneVisible },
  [IPC.ACCOUNT_WEB_PANE_RELOAD]: { args: ['s1'], does: () => acted.reloadAccountPane },
  [IPC.ACCOUNT_WEB_PANE_GET_STATE]: { args: ['s1'], does: () => acted.getAccountPaneState },
}

const mainFrame = { name: 'main' }
const webContents = { mainFrame, send: vi.fn() }
let destroyed = false
const win = { isDestroyed: () => destroyed, webContents }
let current: typeof win | null = win

const APP = { sender: webContents, senderFrame: mainFrame }
/** Every frame shape that is not the app window's main frame. */
const FOREIGN = notAppMainFrameEvents(webContents)

const allActed = () => Object.entries(acted).filter(([, fn]) => fn.mock.calls.length > 0).map(([k]) => k)

beforeEach(() => {
  handlers.clear()
  for (const fn of Object.values(acted)) fn.mockClear()
  logs.lines.length = 0
  destroyed = false
  current = win
  registerAccountWebHandlers(() => current as never)
})

const call = (ch: string, event: unknown) => handlers.get(ch)!(event, ...ROWS[ch].args)

describe('accountWeb:* answers only the app window', () => {
  it('every registered channel has a row here (a new channel cannot go unchecked)', () => {
    const registered = [...handlers.keys()].sort()
    expect(registered.length).toBeGreaterThan(0)
    expect(registered).toEqual(Object.keys(ROWS).sort())
  })

  it('(a) the app window main frame is answered, and the channel does its work', async () => {
    for (const ch of Object.keys(ROWS)) {
      for (const fn of Object.values(acted)) fn.mockClear()
      const res = await call(ch, APP)
      expect(res, ch).not.toEqual(REFUSED)
      expect((res as { ok?: boolean }).ok, ch).toBe(true)
      expect((ROWS[ch].does() as { mock: { calls: unknown[] } }).mock.calls.length, ch).toBeGreaterThan(0)
    }
    expect(logs.lines.filter((l) => l.includes('not the app window'))).toEqual([])
  })

  it('(b, c) any other sender or frame is refused and nothing is touched', async () => {
    for (const ch of Object.keys(ROWS)) {
      for (const [shape, event] of FOREIGN) {
        expect(await call(ch, event), `${ch} from ${shape}`).toEqual(REFUSED)
      }
    }
    expect(allActed()).toEqual([])
  })

  it('(d) a destroyed window, or no window at all, is refused and nothing is touched', async () => {
    for (const ch of Object.keys(ROWS)) {
      destroyed = true
      expect(await call(ch, APP), `${ch} with the window destroyed`).toEqual(REFUSED)
      destroyed = false
      current = null
      expect(await call(ch, APP), `${ch} while there is no window`).toEqual(REFUSED)
      current = win
    }
    expect(allActed()).toEqual([])
  })

  it('a refusal writes one log line, which carries no part of the request', async () => {
    for (const ch of Object.keys(ROWS)) {
      logs.lines.length = 0
      await call(ch, FOREIGN[0][1])
      expect(logs.lines.length, ch).toBe(1)
      expect(logs.lines[0], ch).toMatch(/not the app window/)
      expect(logs.lines[0], ch).not.toContain(PROFILE)
      expect(logs.lines[0], ch).not.toContain('s1')
    }
  })
})

describe('the pane and the artifacts window attach to the app window', () => {
  it('paneOpen attaches to the app window, never to the window the request names as its sender', async () => {
    const res = await call(IPC.ACCOUNT_WEB_PANE_OPEN, APP)
    expect(res).toEqual({ ok: true })
    expect(acted.openAccountPane).toHaveBeenCalledTimes(1)
    const [parent] = acted.openAccountPane.mock.calls[0] as unknown[]
    expect(parent).toBe(win)
    expect(parent).not.toBe(elsewhere)
  })

  it('openArtifacts parents on the app window', async () => {
    const res = await call(IPC.ACCOUNT_WEB_OPEN_ARTIFACTS, APP)
    expect(res).toEqual({ ok: true })
    expect(acted.openArtifacts).toHaveBeenCalledTimes(1)
    const [, parent] = acted.openArtifacts.mock.calls[0] as unknown[]
    expect(parent).toBe(win)
    expect(parent).not.toBe(elsewhere)
  })
})

describe('the handlers are wired to the app window', () => {
  // Pinned from main's source (comments removed): a getter that resolved to
  // no window, or to the window of one moment, would refuse the app itself.
  it('the app registers them once, with its own getter, which reads the window on every call', () => {
    const src = mainIndexSource()
    expect(src.split('registerAccountWebHandlers(').length - 1).toBe(1)
    const at = src.indexOf('registerAccountWebHandlers(')
    expect(src.slice(at)).toMatch(/^registerAccountWebHandlers\(\s*getWindow\s*\)/)
    // The nearest getter before the call is the app's own, and nothing in
    // between assigns another.
    const def = src.lastIndexOf('const getWindow = () => mainWindow', at)
    expect(def).toBeGreaterThan(-1)
    expect(src.slice(def + 'const getWindow'.length, at)).not.toMatch(/\bgetWindow\s*=[^=>]/)
    expect(src).toMatch(/^let mainWindow\b/m)
  })
})
