// @vitest-environment jsdom
/**
 * TerminalView side of the ccc:focus-terminal handoff (#540). The head commit
 * moved the modal check from DISPATCH time to FOCUS time (inside the rAF) so a
 * dialog that mounts between the command dispatch and the frame still traps
 * focus. The existing commandbar-focus-handoff.test.tsx only mounts CommandBar,
 * so it cannot see this — a revert of the fix leaves it green. This file mounts
 * the REAL TerminalView (xterm/IPC mocked) with a controlled rAF and guards the
 * claim directly: the two canaries below FAIL if the check moves back outside
 * the rAF (adversarial review of the focus path, 2026-08-27).
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
    focus: any
    scrollToBottom = () => {}
    constructor(opts?: any) {
      this.options = { ...(opts ?? {}) }
      const calls: unknown[] = []
      const f: any = () => { calls.push(1) }
      f.calls = calls
      f.mockClear = () => { calls.length = 0 }
      this.focus = f
      MockTerminal.last = this
    }
    open(el: HTMLElement) { this.element = el }
    loadAddon() {}
    onData() { return { dispose() {} } }
    onScroll() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
    registerLinkProvider() { return { dispose() {} } }
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

// window.electronAPI: setup.ts installed a base; extend with what TerminalView touches.
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: {
    write: vi.fn(),
    resize: vi.fn(),
    spawn: vi.fn(async () => true),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
  },
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

// Controlled rAF so we can open/close a modal in the dispatch->frame window.
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

const focusCalls = () => (H.MockTerminal.last ? (H.MockTerminal.last.focus as any).calls : [])

const renderView = (props: Record<string, unknown>) => {
  act(() => { root.render(React.createElement(TerminalView as any, props)) })
}

const settleMount = async () => {
  // The init effect defers via rAF; fonts.ready then fitAndSpawn — drain a few rounds.
  for (let i = 0; i < 6; i++) {
    await act(async () => { flushRaf(); await Promise.resolve() })
  }
}

const addModal = () => {
  const m = document.createElement('div')
  m.setAttribute('role', 'dialog')
  m.setAttribute('aria-modal', 'true')
  document.body.appendChild(m)
  return m
}

const dispatchFocus = (sessionId: string) => {
  window.dispatchEvent(new CustomEvent('ccc:focus-terminal', { detail: { sessionId } }))
}

beforeEach(() => {
  rafQueue = []
  installRaf()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.querySelectorAll('[aria-modal="true"]').forEach((n) => n.remove())
  H.MockTerminal.last = null
})

const mountActive = async () => {
  renderView({ sessionId: 's-1', isActive: true })
  await settleMount()
  expect(H.MockTerminal.last).toBeTruthy()
  ;(H.MockTerminal.last.focus as any).mockClear()
}

describe('ccc:focus-terminal — TerminalView listener', () => {
  it('happy path: dispatch then frame focuses the xterm', async () => {
    await mountActive()
    dispatchFocus('s-1')
    expect(focusCalls().length).toBe(0) // nothing before the frame
    flushRaf()
    expect(focusCalls().length).toBe(1)
  })

  it('CANARY: a modal that mounts AFTER dispatch, BEFORE the frame, traps focus (fails if the check moves to dispatch time)', async () => {
    await mountActive()
    dispatchFocus('s-1')
    addModal() // arrives inside the dispatch->frame window
    flushRaf()
    expect(focusCalls().length).toBe(0)
  })

  it('CANARY: a modal open at dispatch but closed by the frame lets the handoff proceed (the reason the check moved off dispatch time)', async () => {
    await mountActive()
    const m = addModal()
    dispatchFocus('s-1') // the OLD dispatch-time check would swallow this legit handoff
    m.remove()
    flushRaf()
    expect(focusCalls().length).toBe(1)
  })

  it('a modal present at both dispatch and frame stays trapped; a double dispatch does not pile past it', async () => {
    await mountActive()
    addModal()
    dispatchFocus('s-1')
    dispatchFocus('s-1')
    flushRaf()
    expect(focusCalls().length).toBe(0)
  })

  it('session filter: an event for another session never focuses this terminal', async () => {
    await mountActive()
    dispatchFocus('someone-else')
    flushRaf()
    expect(focusCalls().length).toBe(0)
  })

  it('an inactive view has no focus listener at all', async () => {
    renderView({ sessionId: 's-1', isActive: false })
    await settleMount()
    ;(H.MockTerminal.last?.focus as any)?.mockClear?.()
    dispatchFocus('s-1')
    flushRaf()
    expect(focusCalls().length).toBe(0)
  })

  it('unmount between dispatch and frame: no crash, no focus into a disposed terminal', async () => {
    await mountActive()
    const term = H.MockTerminal.last
    dispatchFocus('s-1')
    act(() => { root.unmount() })
    expect(() => flushRaf()).not.toThrow()
    expect((term.focus as any).calls.length).toBe(0) // terminalRef nulled in cleanup
  })
})
