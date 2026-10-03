// @vitest-environment jsdom
/**
 * P3.16a (N8): TerminalView's PTY-integrity report names the mount its counts
 * are from. The view counts the bytes it receives from 0 each time its terminal
 * effect starts, and a re-key that does not respawn the PTY (a Restart pressed
 * from the partner view re-keys the MAIN view while main's PTY runs on) starts
 * that count again. Main restarts its own count for the session when the
 * generation changes (pty-integrity-monitor.test.ts, N8), so each mount must
 * send its own generation, the same one on every report of that mount.
 *
 * Mounts the REAL TerminalView (xterm/IPC mocked) after
 * terminalview-focus-handoff.test.tsx; the view adopts a running PTY
 * (hasSpawned true), as the re-keyed main view does.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const H = vi.hoisted(() => {
  class MockTerminal {
    static last: any = null
    options: any
    cols = 80
    rows = 24
    element: HTMLElement | null = null
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, length: 0, cursorY: 0 } }
    constructor(opts?: any) {
      this.options = { ...(opts ?? {}) }
      MockTerminal.last = this
    }
    focus() {}
    scrollToBottom() {}
    open(el: HTMLElement) { this.element = el }
    loadAddon() {}
    onData() { return { dispose() {} } }
    onScroll() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    registerLinkProvider() { return { dispose() {} } }
    write() {}
    writeln() {}
    refresh() {}
    paste() {}
    clearSelection() {}
    getSelection() { return '' }
    dispose() {}
  }
  const sessionState = {
    sessions: [
      { id: 's-1', label: 'one', workingDirectory: '/', color: '#89b4fa', sessionType: 'local', provider: 'claude', model: 'sonnet' },
    ],
    activeSessionId: 's-1',
    updateSession: () => {},
  }
  return { MockTerminal, sessionState }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({ default: {} }))
vi.mock('@xterm/xterm', () => ({ Terminal: H.MockTerminal }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } } }))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }))
vi.mock('../../../src/renderer/components/terminal/terminalWebgl', () => ({
  installWebglWithRecovery: () => ({ dispose() {}, clearTextureAtlas: () => false, isActive: () => false }),
  createAtlasResync: () => () => {},
}))
vi.mock('../../../src/renderer/components/terminal/atlasCoordinator', () => ({
  atlasCoordinator: { register: () => () => {}, notifyCleared: () => {}, resyncIfBehind: () => {} },
}))
vi.mock('../../../src/renderer/components/terminal/staleGlyphRepaint', () => ({
  createStaleGlyphRepainter: () => ({ schedule() {}, settle() {}, settleStrong() {}, strongIfStale() {}, dispose() {} }),
  shouldRepaintOnOutput: () => false,
  shouldSoftRepaintOnOutput: () => false,
  outputRepaintIntervalMs: () => 1000,
  ACTIVATION_MAX_STALE_MS: 1000,
  WHEEL_ACTIVE_MS: 100,
}))
vi.mock('../../../src/renderer/components/terminal/terminalTheme', () => ({ getTerminalTheme: () => ({ background: '#000000' }) }))
vi.mock('../../../src/renderer/components/terminal/terminalKeybindings', () => ({ installTerminalKeybindings: () => () => {} }))
vi.mock('../../../src/renderer/components/terminal/repaintRegistry', () => ({
  registerRepainter: () => () => {},
  requestResync: () => {},
  scheduleBleedRepaints: () => {},
}))
vi.mock('../../../src/renderer/components/terminal/geometryResync', () => ({
  createGeometryResync: () => ({ fire() {}, dispose() {} }),
}))
vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign((sel: any) => sel(H.sessionState), { getState: () => H.sessionState }),
}))
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({ useRestartSession: () => ({ restart: () => {} }) }))
vi.mock('../../../src/renderer/session-persistence', () => ({ persistLastUsedAccount: () => {} }))
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => {
  const st = { profiles: [] }
  return { useAccountProfilesStore: Object.assign((sel: any) => sel(st), { getState: () => st }) }
})
vi.mock('../../../src/renderer/stores/accountGateStore', () => {
  const st = { pendingBySession: {}, open: () => {}, close: () => {} }
  return { useAccountGateStore: Object.assign((sel: any) => sel(st), { getState: () => st }), GATE_CANCELLED: 'cancelled' }
})
vi.mock('../../../src/renderer/stores/sshCloseStore', () => ({ forgetSessionBrowserProfile: () => {} }))
vi.mock('../../../src/renderer/ptyTracker', () => ({
  hasSpawned: () => true,
  markSpawned: () => {},
  clearSpawned: () => {},
  killSessionPty: () => {},
}))
vi.mock('../../../src/renderer/components/SshFlowOverlay', () => ({ default: () => null }))
vi.mock('../../../src/renderer/utils/resumePicker', () => ({ shouldUseResumePicker: () => false }))
vi.mock('../../../src/renderer/utils/sessionLaunch', () => ({ shouldGateAccountChoice: () => false, formatSpawnError: () => '' }))
vi.mock('../../../src/renderer/components/TerminalContextMenu', () => ({ default: () => null }))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const st = { settings: { terminal: {} } }
  return {
    useSettingsStore: Object.assign((sel: any) => sel(st), { getState: () => st }),
    DEFAULT_TERMINAL_SETTINGS: {},
    gpuRenderingEnabled: () => false,
  }
})
vi.mock('../../../src/renderer/stores/pasteHintStore', () => {
  const st = { show: () => {} }
  return { usePasteHintStore: Object.assign((sel: any) => sel(st), { getState: () => st }) }
})
vi.mock('../../../src/renderer/utils/inputDiagnostics', () => ({ installInputDiagnostics: () => () => {}, describeBytes: () => '' }))
vi.mock('../../../src/renderer/components/terminal', () => ({ ScrollToBottomButton: () => null }))
vi.mock('../../../src/renderer/hooks/useStatuslineSubscription', () => ({ useStatuslineSubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useEffortSubscription', () => ({ useEffortSubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useWatchdogSubscription', () => ({ useWatchdogSubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useAccountIdentitySubscription', () => ({ useAccountIdentitySubscription: () => {} }))
vi.mock('../../../src/renderer/hooks/useActiveTabEffect', () => ({ useActiveTabEffect: () => {} }))
vi.mock('../../../src/renderer/hooks/useCursorLayerVisibility', () => ({ useCursorLayerVisibility: () => {} }))

type DataCb = (data: string) => void
const dataCbs: DataCb[] = []
const report = vi.fn()

// window.electronAPI: setup.ts installed a base; extend with what TerminalView touches.
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: {
    write: vi.fn(),
    resize: vi.fn(),
    spawn: vi.fn(async () => true),
    onData: vi.fn((_id: string, cb: DataCb) => { dataCbs.push(cb); return () => {} }),
    onExit: vi.fn(() => () => {}),
  },
  ptyIntegrity: { report },
  inputDebug: { enabled: vi.fn(async () => false), log: vi.fn() },
  clipboard: { readText: vi.fn(async () => '') },
  ssh: { onSessionInfo: vi.fn(() => () => {}), onFlowState: vi.fn(() => () => {}) },
}

// jsdom gaps: no layout, so initTerminal would spin on a 0x0 container.
Element.prototype.getBoundingClientRect = function () {
  return { width: 800, height: 600, top: 0, left: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON() { return {} } } as DOMRect
}
class RO { observe() {} unobserve() {} disconnect() {} }
;(globalThis as any).ResizeObserver = RO
;(window as any).ResizeObserver = RO
if (!(document as any).fonts) {
  Object.defineProperty(document, 'fonts', { value: { ready: Promise.resolve(), load: () => Promise.resolve([]) }, configurable: true })
}

let rafQueue: FrameRequestCallback[] = []
let rafId = 0
const installRaf = () => {
  const req = (cb: FrameRequestCallback) => { rafQueue.push(cb); return ++rafId }
  const cancel = () => {}
  ;(window as any).requestAnimationFrame = req
  ;(globalThis as any).requestAnimationFrame = req
  ;(window as any).cancelAnimationFrame = cancel
  ;(globalThis as any).cancelAnimationFrame = cancel
}
const flushRaf = () => { const q = rafQueue; rafQueue = []; q.forEach((cb) => cb(0)) }

const { default: TerminalView } = await import('../../../src/renderer/components/TerminalView')

let container: HTMLDivElement
let root: Root

/** Mount (or re-key) the view of session s-1 and let its terminal effect start. */
const mount = async (key: string): Promise<DataCb> => {
  const before = dataCbs.length
  act(() => { root.render(React.createElement(TerminalView as any, { key, sessionId: 's-1', isActive: true })) })
  for (let i = 0; i < 6; i++) {
    await act(async () => { flushRaf(); await Promise.resolve() })
  }
  expect(dataCbs.length, 'the mount listens for the PTY output').toBeGreaterThan(before)
  return dataCbs[dataCbs.length - 1]
}

/** Deliver PTY output to a mount, then let its throttled report go. */
const deliver = (cb: DataCb, data: string) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    act(() => { cb(data) })
    act(() => { vi.advanceTimersByTime(1000) })
  } finally {
    vi.useRealTimers()
  }
}

const reports = () => report.mock.calls.map((c) => c[0] as { sessionId: string; bytesReceived: number; generation?: unknown })

beforeEach(() => {
  rafQueue = []
  installRaf()
  dataCbs.length = 0
  report.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  H.MockTerminal.last = null
})

describe('TerminalView integrity report: one generation per mount (N8)', () => {
  it('every report of a mount carries the same bounded generation', async () => {
    const cb = await mount('a')
    deliver(cb, 'x'.repeat(100))
    deliver(cb, 'y'.repeat(50))
    const r = reports().filter((x) => x.sessionId === 's-1')
    expect(r.map((x) => x.bytesReceived)).toEqual([100, 150])
    expect(typeof r[0].generation).toBe('string')
    expect(r[0].generation).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(r[1].generation).toBe(r[0].generation)
  })

  it('a re-key of the same session (no respawn) reports a new generation, its count from 0', async () => {
    const first = await mount('a')
    deliver(first, 'x'.repeat(100))
    const before = reports().filter((x) => x.sessionId === 's-1')
    expect(before).toHaveLength(1)
    const second = await mount('b')
    deliver(second, 'z'.repeat(30))
    const after = reports().filter((x) => x.sessionId === 's-1')
    expect(after).toHaveLength(2)
    expect(after[1].bytesReceived).toBe(30)
    expect(after[1].generation).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(after[1].generation).not.toBe(before[0].generation)
  })
})
