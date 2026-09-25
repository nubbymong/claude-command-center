// @vitest-environment jsdom
/**
 * WP2 commit 6: a Codex session's launch, through the REAL TerminalView
 * (xterm and IPC mocked, the accounts, launch-confirm and account-gate stores
 * real).
 *
 *  - the session's saved providerAccountId reaches pty:spawn;
 *  - a later launch of a session bound to this computer's own ~/.codex asks
 *    first: declined -> nothing spawns; accepted -> the spawn carries
 *    acknowledgeRealmOnly: true for THAT account (the New session dialog's
 *    tick covers only the launch it started, and is used up by it);
 *  - main's refusals are said in plain words in the terminal;
 *  - the Restart pty:exit race (plan.md "For commit 6 (renderer)"): an exit
 *    that arrives before this view's own pty:spawn has settled belongs to the
 *    run it replaces and does not mark the live session exited; one after it
 *    does; and when this view's spawn starts nothing, a held exit ends it.
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
    lines: string[] = []
    focus = () => {}
    scrollToBottom = () => {}
    constructor(opts?: any) { this.options = { ...(opts ?? {}) }; MockTerminal.last = this }
    open(el: HTMLElement) { this.element = el }
    loadAddon() {}
    onData() { return { dispose() {} } }
    onScroll() { return { dispose() {} } }
    attachCustomKeyEventHandler() {}
    attachCustomWheelEventHandler() {}
    registerLinkProvider() { return { dispose() {} } }
    refresh() {}
    paste() {}
    clearSelection() {}
    getSelection() { return '' }
    write() {}
    writeln(s: string) { this.lines.push(s) }
    dispose() {}
  }
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = []
  const sessionState: any = {
    sessions: [] as any[],
    activeSessionId: 's-1',
    updateSession: (id: string, patch: Record<string, unknown>) => { updates.push({ id, patch }) },
  }
  const spawned = new Set<string>()
  // The spawn tokens ptyTracker hands out (markSpawned) and checks (isCurrentSpawn).
  const tokens = new Map<string, number>()
  const counter = { last: 0 }
  const cleared: string[] = []
  return { MockTerminal, sessionState, updates, spawned, tokens, counter, cleared }
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
vi.mock('../../../src/renderer/stores/sshCloseStore', () => ({ forgetSessionBrowserProfile: () => {} }))
vi.mock('../../../src/renderer/ptyTracker', () => ({
  hasSpawned: (id: string) => H.spawned.has(id),
  markSpawned: (id: string) => { H.spawned.add(id); const t = ++H.counter.last; H.tokens.set(id, t); return t },
  isCurrentSpawn: (id: string, t: number | undefined) => H.spawned.has(id) && t !== undefined && H.tokens.get(id) === t,
  clearSpawned: (id: string) => { H.spawned.delete(id); H.tokens.delete(id); H.cleared.push(id) },
  killSessionPty: () => {},
}))
// A marker, so a test can see whether an SSH tab shows its flow card.
vi.mock('../../../src/renderer/components/SshFlowOverlay', async () => {
  const R = await import('react')
  return { default: () => R.createElement('div', { 'data-testid': 'ssh-flow-overlay' }) }
})
vi.mock('../../../src/renderer/utils/resumePicker', () => ({ shouldUseResumePicker: () => false }))
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

// pty:spawn calls are deferreds the test settles, one per call; pty:exit is a
// callback it fires at whichever view is listening now.
type Settle = { resolve: (v?: unknown) => void; reject: (e: unknown) => void }
const settles: Settle[] = []
const spawn = vi.fn((_id: string, _opts: Record<string, unknown>) => new Promise((resolve, reject) => { settles.push({ resolve, reject }) }))
let fireExit: ((code: number) => void) | null = null
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  pty: {
    write: vi.fn(),
    resize: vi.fn(),
    spawn,
    onData: vi.fn(() => () => {}),
    onExit: vi.fn((_id: string, cb: (code: number) => void) => { fireExit = cb; return () => { if (fireExit === cb) fireExit = null } }),
  },
  inputDebug: { enabled: vi.fn(async () => false), log: vi.fn() },
  clipboard: { readText: vi.fn(async () => '') },
  ssh: { onSessionInfo: vi.fn(() => () => {}), onFlowState: vi.fn(() => () => {}) },
}

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
const installRaf = () => {
  const req = (cb: FrameRequestCallback) => { rafQueue.push(cb); return rafQueue.length }
  ;(window as any).requestAnimationFrame = req
  ;(globalThis as any).requestAnimationFrame = req
  ;(window as any).cancelAnimationFrame = () => {}
  ;(globalThis as any).cancelAnimationFrame = () => {}
}
const flushRaf = () => { const q = rafQueue; rafQueue = []; q.forEach((cb) => cb(0)) }

const { default: TerminalView } = await import('../../../src/renderer/components/TerminalView')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { useLaunchAckStore, grantLaunchAcknowledgement, consumeLaunchAcknowledgement } = await import('../../../src/renderer/stores/launchAckStore')
const { useAccountGateStore } = await import('../../../src/renderer/stores/accountGateStore')
const { snapshot, provider, account } = await import('./accounts-snapshot-harness')
const { forgetSpawnEnd } = await import('../../../src/renderer/utils/spawnEndNotice')

let container: HTMLDivElement
let root: Root

function codexSession(over: Record<string, unknown> = {}) {
  return { id: 's-1', label: 'api-server', workingDirectory: 'C:/proj', color: '#89b4fa', sessionType: 'local', provider: 'codex', model: '', codexOptions: { permissionsPreset: 'standard' }, ...over }
}

/** Mount the view (a new `key` is a remount: what a Restart does) and run it
 *  up to, not past, the frames that spawn. */
const mount = (session: Record<string, unknown>, key = 'a') => {
  H.sessionState.sessions = [session]
  act(() => {
    root.render(React.createElement(TerminalView as any, {
      key, sessionId: 's-1', cwd: 'C:/proj', isActive: true, provider: session.provider, codexOptions: session.codexOptions,
    }))
  })
}
/** Drain frames and microtasks until the view has done what it will. */
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(async () => { flushRaf(); await Promise.resolve(); await Promise.resolve() })
}
/** What a Restart does before the remount: killSessionPty clears the tracker. */
const restartTo = async (session: Record<string, unknown>, key: string) => {
  H.spawned.delete('s-1')
  mount(session, key)
  await settle()
}
const termLines = () => (H.MockTerminal.last?.lines ?? []).join('\n')
const exitedMarks = () => H.updates.filter((u) => u.patch.ptyExited === true)
const answer = async (yes: boolean) => {
  const q = useLaunchAckStore.getState().queue
  await act(async () => { useLaunchAckStore.getState().answer(q[0].requestId, yes) })
}
const refused = (why: string) => new Error(`Error invoking remote method 'pty:spawn': Error: Codex session refused: ${why}`)

beforeEach(() => {
  rafQueue = []
  installRaf()
  spawn.mockClear()
  settles.length = 0
  fireExit = null
  H.updates.length = 0
  H.spawned.clear()
  H.tokens.clear()
  forgetSpawnEnd('s-1')
  H.cleared.length = 0
  H.MockTerminal.last = null
  useProviderAccountsStore.setState({ snapshot: snapshot(), loaded: true })
  useLaunchAckStore.setState({ queue: [] })
  useAccountGateStore.setState({ queue: [], predetermined: [], restored: [] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe("a Codex session's account reaches pty:spawn", () => {
  it('sends the saved providerAccountId, with no acknowledgement for a managed account', async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
    const opts = spawn.mock.calls[0][1]
    expect(opts.providerAccountId).toBe('acc-work')
    expect(opts.acknowledgeRealmOnly).toBeUndefined()
    expect(useLaunchAckStore.getState().queue).toHaveLength(0)
  })

  it('an unbound session names no account (the provider default, as before)', async () => {
    mount(codexSession())
    await settle()
    expect(spawn.mock.calls[0][1].providerAccountId).toBeUndefined()
  })

  it('a Claude session never sends one', async () => {
    mount(codexSession({ provider: 'claude', providerAccountId: 'acc-work', codexOptions: undefined }))
    await settle()
    expect(spawn.mock.calls[0][1].providerAccountId).toBeUndefined()
  })
})

describe("a later launch on this computer's own sign-in asks first", () => {
  it('declined: nothing spawns, and the terminal says why', async () => {
    mount(codexSession({ providerAccountId: 'acc-local' }))
    await settle()
    const q = useLaunchAckStore.getState().queue
    expect(q).toHaveLength(1)
    expect(q[0]).toMatchObject({ sessionId: 's-1', external: true, email: 'alex@example.com', unknown: false })
    await answer(false)
    await settle()
    expect(spawn).not.toHaveBeenCalled()
    expect(termLines()).toContain('Not started: the launch was not confirmed.')
    expect(exitedMarks()).toHaveLength(1)
  })

  it("accepted: the spawn carries THIS launch's acknowledgement for that account", async () => {
    mount(codexSession({ providerAccountId: 'acc-local' }))
    await settle()
    expect(spawn).not.toHaveBeenCalled()
    await answer(true)
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][1]).toMatchObject({ providerAccountId: 'acc-local', acknowledgeRealmOnly: true })
  })

  it("the New session dialog's tick covers its own launch without asking, and is used up", async () => {
    grantLaunchAcknowledgement('s-1', 'acc-local')
    mount(codexSession({ providerAccountId: 'acc-local' }))
    await settle()
    expect(useLaunchAckStore.getState().queue).toHaveLength(0)
    expect(spawn.mock.calls[0][1]).toMatchObject({ providerAccountId: 'acc-local', acknowledgeRealmOnly: true })
    expect(consumeLaunchAcknowledgement('s-1', 'acc-local')).toBe(false)
  })

  it('a tick given for another account does not count', async () => {
    grantLaunchAcknowledgement('s-1', 'acc-work')
    mount(codexSession({ providerAccountId: 'acc-local' }))
    await settle()
    expect(spawn).not.toHaveBeenCalled()
    expect(useLaunchAckStore.getState().queue).toHaveLength(1)
  })

  it('with no account list (the snapshot fetch failed), a bound session still asks, and a yes names that account', async () => {
    useProviderAccountsStore.setState({ snapshot: null, loaded: true })
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    expect(spawn).not.toHaveBeenCalled()
    expect(useLaunchAckStore.getState().queue[0]).toMatchObject({ sessionId: 's-1', unknown: true })
    await answer(true)
    await settle()
    expect(spawn.mock.calls[0][1]).toMatchObject({ providerAccountId: 'acc-work', acknowledgeRealmOnly: true })
  })

  it('the account list arriving while that question is up: an account that needs nothing starts without asking', async () => {
    useProviderAccountsStore.setState({ snapshot: null, loaded: true })
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    expect(useLaunchAckStore.getState().queue[0]).toMatchObject({ unknown: true })
    await act(async () => { useProviderAccountsStore.setState({ snapshot: snapshot(), loaded: true }) })
    await settle()
    expect(useLaunchAckStore.getState().queue).toHaveLength(0)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][1].providerAccountId).toBe('acc-work')
    expect(spawn.mock.calls[0][1].acknowledgeRealmOnly).toBeUndefined()
    expect(exitedMarks()).toHaveLength(0)
  })

  it('the account list arriving while that question is up: an account that needs confirming is asked about in its own words', async () => {
    useProviderAccountsStore.setState({ snapshot: null, loaded: true })
    mount(codexSession({ providerAccountId: 'acc-local' }))
    await settle()
    const stale = useLaunchAckStore.getState().queue[0]
    expect(stale).toMatchObject({ unknown: true })
    await act(async () => { useProviderAccountsStore.setState({ snapshot: snapshot(), loaded: true }) })
    await settle()
    const q = useLaunchAckStore.getState().queue
    expect(q).toHaveLength(1)
    expect(q[0].requestId).not.toBe(stale.requestId)
    expect(q[0]).toMatchObject({ unknown: false, external: true, email: 'alex@example.com' })
    expect(spawn).not.toHaveBeenCalled()
    await answer(true)
    await settle()
    expect(spawn.mock.calls[0][1]).toMatchObject({ providerAccountId: 'acc-local', acknowledgeRealmOnly: true })
  })

  it('a Restart while its confirm is up withdraws that question, and the new view asks afresh', async () => {
    mount(codexSession({ providerAccountId: 'acc-local' }))
    await settle()
    const first = useLaunchAckStore.getState().queue[0]
    await restartTo(codexSession({ providerAccountId: 'acc-local' }), 'b')
    const q = useLaunchAckStore.getState().queue
    expect(q).toHaveLength(1)
    expect(q[0].requestId).not.toBe(first.requestId)
    // The withdrawn question started nothing.
    expect(spawn).not.toHaveBeenCalled()
    await answer(true)
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describe("main's refusals, in plain words at the terminal", () => {
  it('lifecycle', async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    await act(async () => { settles[0].reject(refused('the account is inactive; activate it or choose another')) })
    expect(termLines()).toContain('Codex did not start. This account needs attention. Open Accounts.')
    expect(termLines()).not.toContain('Process exited')
  })

  it("acknowledgement-required says 'on this computer' only for this computer's own sign-in", async () => {
    grantLaunchAcknowledgement('s-1', 'acc-local')
    mount(codexSession({ providerAccountId: 'acc-local' }))
    await settle()
    await act(async () => { settles[0].reject(refused('This sign-in is unverified: confirm that this launch may use it.')) })
    expect(termLines()).toContain('the Codex sign-in already on this computer')
  })

  it("acknowledgement-required for a managed unverified account names that account's sign-in", async () => {
    const managedUnverified = account({ id: 'acc-api', providerId: 'codex', identityId: 'id-work', unverified: true, identityAssurance: 'realm-only' })
    useProviderAccountsStore.setState({ snapshot: snapshot({ accounts: [managedUnverified] }), loaded: true })
    grantLaunchAcknowledgement('s-1', 'acc-api')
    mount(codexSession({ providerAccountId: 'acc-api' }))
    await settle()
    await act(async () => { settles[0].reject(refused('This sign-in is unverified: confirm that this launch may use it.')) })
    expect(termLines()).toContain("this account's unverified sign-in")
    expect(termLines()).not.toContain('on this computer')
  })

  it('"too old" only when discovery judged the CLI too old; otherwise "could not check"', async () => {
    const why = 'This Codex CLI version cannot be used for sign-in. Update it, then check it again in setup.'
    useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [provider({ providerId: 'codex', displayName: 'Codex', version: '0.150.2', compatibility: 'too-old' })] }), loaded: true })
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    await act(async () => { settles[0].reject(refused(why)) })
    expect(termLines()).toContain('Codex 0.150.2 is too old for this app. Update Codex, then Check again in Settings, Accounts.')
    useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [provider({ providerId: 'codex', displayName: 'Codex', compatibility: 'unknown' })] }), loaded: true })
    await restartTo(codexSession({ providerAccountId: 'acc-work' }), 'b')
    await act(async () => { settles[1].reject(refused(why)) })
    expect(termLines()).toContain('This app could not check Codex. Open Accounts.')
    expect(termLines()).not.toContain('too old')
  })
})

describe('the Restart pty:exit race', () => {
  it('an exit before this view has even called pty:spawn does not mark the session exited', async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    // One frame: the view is listening, its spawn is still frames away.
    await act(async () => { flushRaf() })
    expect(fireExit).not.toBeNull()
    expect(spawn).not.toHaveBeenCalled()
    fireExit!(-1)
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
    await act(async () => { settles[0].resolve(undefined) })
    expect(exitedMarks()).toHaveLength(0)
    expect(H.cleared).toHaveLength(0)
    expect(termLines()).not.toContain('Process exited')
  })

  it('an exit while pty:spawn is in flight does not; one after it resolved does', async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
    fireExit!(1)
    expect(exitedMarks()).toHaveLength(0)
    await act(async () => { settles[0].resolve(undefined) })
    expect(exitedMarks()).toHaveLength(0)
    expect(H.spawned.has('s-1')).toBe(true)
    // The new PTY's own exit.
    act(() => { fireExit!(0) })
    expect(exitedMarks()).toHaveLength(1)
    expect(termLines()).toContain('[Process exited with code 0]')
  })

  it('a view that remounts onto a running PTY applies exits as they arrive', async () => {
    H.spawned.add('s-1')
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    expect(spawn).not.toHaveBeenCalled()
    act(() => { fireExit!(0) })
    expect(exitedMarks()).toHaveLength(1)
  })

  it('when main started nothing for this spawn, the held exit ends the session', async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    fireExit!(-1)
    await act(async () => { settles[0].resolve({ started: false }) })
    expect(exitedMarks()).toHaveLength(1)
    expect(termLines()).toContain('[The launch was cancelled before the session started]')
  })

  it('when this spawn was refused, the held exit ends the session', async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    fireExit!(1)
    await act(async () => { settles[0].reject(refused('This account is signing in again; try again when that finishes.')) })
    expect(exitedMarks()).toHaveLength(1)
    expect(termLines()).toContain('Codex did not start. This account is signing in again.')
  })
})

describe('a replaced view never settles the live session (Restart during a preparation)', () => {
  it("the replaced view's { started: false } after the new PTY is live marks nothing", async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    await restartTo(codexSession({ providerAccountId: 'acc-work' }), 'b')
    expect(spawn).toHaveBeenCalledTimes(2)
    await act(async () => { settles[1].resolve(undefined) })
    await act(async () => { settles[0].resolve({ started: false }) })
    expect(exitedMarks()).toHaveLength(0)
    expect(H.cleared).toHaveLength(0)
    expect(H.spawned.has('s-1')).toBe(true)
  })

  it("the replaced view's { started: false } while the new spawn is still in flight marks nothing", async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    await restartTo(codexSession({ providerAccountId: 'acc-work' }), 'b')
    await act(async () => { settles[0].resolve({ started: false }) })
    expect(exitedMarks()).toHaveLength(0)
    expect(H.cleared).toHaveLength(0)
    await act(async () => { settles[1].resolve(undefined) })
    expect(exitedMarks()).toHaveLength(0)
    expect(H.spawned.has('s-1')).toBe(true)
  })

  it('a replaced view that held an exit and then fails marks nothing once the new PTY is live', async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    fireExit!(1)
    await restartTo(codexSession({ providerAccountId: 'acc-work' }), 'b')
    await act(async () => { settles[1].resolve(undefined) })
    await act(async () => { settles[0].reject(refused('This account is signing in again; try again when that finishes.')) })
    expect(exitedMarks()).toHaveLength(0)
    expect(H.cleared).toHaveLength(0)
  })
})

describe('the branches where this view starts nothing', () => {
  it('an account gate already up for the session: no spawn, and a held exit ends it', async () => {
    void useAccountGateStore.getState().requestChoice('s-1', 'api-server', undefined)
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await act(async () => { flushRaf() })
    fireExit!(1)
    await settle()
    expect(spawn).not.toHaveBeenCalled()
    expect(exitedMarks()).toHaveLength(1)
  })

  it('an account gate already up, and no exit held: nothing is marked', async () => {
    void useAccountGateStore.getState().requestChoice('s-1', 'api-server', undefined)
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    expect(spawn).not.toHaveBeenCalled()
    expect(exitedMarks()).toHaveLength(0)
    // Exits apply again: this view is not starting anything.
    act(() => { fireExit!(0) })
    expect(exitedMarks()).toHaveLength(1)
  })

  it('a launch confirm already queued for the session: no second question, no spawn, a held exit ends it', async () => {
    void useLaunchAckStore.getState().request({ sessionId: 's-1', sessionLabel: 'x', accountName: 'y', external: true, unknown: false })
    mount(codexSession({ providerAccountId: 'acc-local' }))
    await act(async () => { flushRaf() })
    fireExit!(1)
    await settle()
    expect(spawn).not.toHaveBeenCalled()
    expect(useLaunchAckStore.getState().queue).toHaveLength(1)
    expect(exitedMarks()).toHaveLength(1)
  })

  it('something else started the PTY between mount and spawn: no spawn, and a held exit ends it', async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await act(async () => { flushRaf() })
    fireExit!(1)
    H.spawned.add('s-1')
    await settle()
    expect(spawn).not.toHaveBeenCalled()
    expect(exitedMarks()).toHaveLength(1)
  })
})

describe('a view remounted without a Restart (a partner-terminal restart re-keys the main view)', () => {
  /** A remount that keeps the spawn tracker: the new view adopts the old
   *  view's in-flight spawn instead of starting its own. */
  const remountTo = async (key: string) => {
    mount(codexSession({ providerAccountId: 'acc-work' }), key)
    await settle()
  }

  it("the adopted spawn's refusal is said in the new view, and the session ends", async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    await remountTo('b')
    expect(spawn).toHaveBeenCalledTimes(1)
    await act(async () => { settles[0].reject(refused('the account is inactive; activate it or choose another')) })
    expect(termLines()).toContain('Codex did not start. This account needs attention. Open Accounts.')
    expect(exitedMarks()).toHaveLength(1)
    expect(H.spawned.has('s-1')).toBe(false)
  })

  it("the adopted spawn's { started: false } ends the session in the new view", async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    await remountTo('b')
    await act(async () => { settles[0].resolve({ started: false }) })
    expect(termLines()).toContain('[The launch was cancelled before the session started]')
    expect(exitedMarks()).toHaveLength(1)
  })

  it('an adopted spawn that started a PTY ends nothing', async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    await remountTo('b')
    await act(async () => { settles[0].resolve(undefined) })
    expect(exitedMarks()).toHaveLength(0)
    expect(H.spawned.has('s-1')).toBe(true)
    // The adopted PTY's own exit reaches the new view.
    act(() => { fireExit!(0) })
    expect(exitedMarks()).toHaveLength(1)
  })
})

describe('a live session is never left flagged exited', () => {
  it('a spawn that starts a PTY clears a stale ptyExited on the session', async () => {
    mount(codexSession({ providerAccountId: 'acc-work', ptyExited: true }))
    await settle()
    await act(async () => { settles[0].resolve(undefined) })
    expect(H.updates.some((u) => 'ptyExited' in u.patch && u.patch.ptyExited === undefined)).toBe(true)
  })

  it('a spawn that starts nothing leaves the flag alone (nothing to clear)', async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    await act(async () => { settles[0].resolve(undefined) })
    expect(H.updates.some((u) => 'ptyExited' in u.patch && u.patch.ptyExited === undefined)).toBe(false)
  })

  it('a view remounted while hidden hears the refusal when it is first shown, and does not spawn again', async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    // Remounted without a Restart while its pane is hidden: it has not
    // started (no frame yet), so nothing is listening when the refusal lands.
    mount(codexSession({ providerAccountId: 'acc-work' }), 'b')
    await act(async () => { settles[0].reject(refused('the account is inactive; activate it or choose another')) })
    // Shown: it starts, hears the kept refusal, says it and ends the session.
    await settle()
    expect(termLines()).toContain('Codex did not start. This account needs attention. Open Accounts.')
    expect(exitedMarks().length).toBeGreaterThan(0)
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describe('WP2 6e: a transient tab (Run in a terminal) runs its command once', () => {
  const CMD = 'npm install -g @openai/codex'
  const tab = (over: Record<string, unknown> = {}) => ({
    id: 's-1', label: 'Install Codex', workingDirectory: '', color: '#89b4fa', sessionType: 'local', provider: 'claude', model: '',
    shellOnly: true, transient: true, terminalOptions: { command: CMD, elevated: false }, ...over,
  })
  const mountShell = (session: Record<string, unknown>) => {
    H.sessionState.sessions = [session]
    act(() => {
      root.render(React.createElement(TerminalView as any, {
        key: 'shell', sessionId: 's-1', cwd: '', isActive: true, shellOnly: true, provider: 'claude', terminalOptions: session.terminalOptions,
      }))
    })
  }
  const optionPatches = () => H.updates.filter((u) => 'terminalOptions' in u.patch)

  it('the first spawn carries the command, and the session record loses it at once', async () => {
    mountShell(tab())
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][1].terminalOptions).toEqual({ command: CMD, elevated: false })
    expect(optionPatches()).toEqual([{ id: 's-1', patch: { terminalOptions: { elevated: false } } }])
  })

  it('a saved terminal-only config keeps its command (configuration, run on every launch)', async () => {
    mountShell(tab({ transient: undefined, configId: 'cfg-1' }))
    await settle()
    expect(spawn.mock.calls[0][1].terminalOptions).toEqual({ command: CMD, elevated: false })
    expect(optionPatches()).toEqual([])
  })
})

// WP2: main refuses every launch of a provider that is switched off
// (src/main/provider-launch-gate.ts). A restored session and a Restart both
// reach main through this view's ONE pty:spawn (a restore mounts the view
// with the saved exact-conversation target; a Restart remounts it), so a
// refusal is said in the tab, in main's own words plus what to do: no crash,
// no blank terminal, no retry loop, and the session is kept -- with its
// restore target back on the record, so a Restart once the provider is on
// resumes the same conversation. While the renderer already knows the
// provider is off, nothing is asked first (no sign-in confirmation, no
// account picker) and an SSH tab shows no "Connecting..." card.
describe('main refuses a launch because its provider is off', () => {
  const OFF = 'Claude Code is off. Turn it on in Settings, Accounts.'
  const OFF_TAB = 'Not started. Claude Code is off. Turn it on in Settings, Accounts, then Restart this tab.'
  const CODEX_OFF_TAB = 'Not started. Codex is off. Turn it on in Settings, Accounts, then Restart this tab.'
  const claudeOff = { started: false, refused: { code: 'provider-off', providerId: 'claude', message: OFF } }
  const codexOff = { started: false, refused: { code: 'provider-off', providerId: 'codex', message: 'Codex is off. Turn it on in Settings, Accounts.' } }
  const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const claudeSession = (over: Record<string, unknown> = {}) => codexSession({ provider: 'claude', codexOptions: undefined, ...over })
  const SSH = { host: 'build-box', port: 22, username: 'nick', remotePath: '~' }
  const mountSsh = (key = 'ssh') => {
    H.sessionState.sessions = [claudeSession({ sessionType: 'ssh' })]
    act(() => {
      root.render(React.createElement(TerminalView as any, { key, sessionId: 's-1', cwd: '~', isActive: true, provider: 'claude', ssh: SSH }))
    })
  }
  const overlay = () => container.querySelector('[data-testid="ssh-flow-overlay"]')
  let removeSession: ReturnType<typeof vi.fn>
  let settingsState: { settings: Record<string, unknown> }
  let profilesState: { profiles: unknown[] }
  beforeEach(async () => {
    removeSession = vi.fn()
    H.sessionState.removeSession = removeSession
    const { useSettingsStore } = await import('../../../src/renderer/stores/settingsStore')
    const { useAccountProfilesStore } = await import('../../../src/renderer/stores/accountProfilesStore')
    settingsState = (useSettingsStore as any).getState()
    profilesState = (useAccountProfilesStore as any).getState()
  })
  afterEach(() => {
    delete settingsState.settings.claudeEnabled
    delete settingsState.settings.codexEnabled
    profilesState.profiles = []
  })

  it('a restored session: pty:spawn carries its restore target; the refusal is said in the tab and the session is kept, target and all', async () => {
    mount(claudeSession({ resumeUuid: UUID, resumeCwd: 'C:/proj' }))
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][1].resume).toEqual({ uuid: UUID, cwd: 'C:/proj' })
    await act(async () => { settles[0].resolve(claudeOff) })
    await settle()
    expect(termLines()).toContain(OFF_TAB)
    expect(termLines()).not.toContain('Failed to launch')
    expect(exitedMarks()).toHaveLength(1)
    // Consumed for the spawn, then put back when main refused it.
    const targets = H.updates.filter((u) => 'resumeUuid' in u.patch).map((u) => u.patch.resumeUuid)
    expect(targets).toEqual([undefined, UUID])
    expect(H.updates.find((u) => u.patch.resumeUuid === UUID)!.patch.resumeCwd).toBe('C:/proj')
    expect(removeSession).not.toHaveBeenCalled()
    // No retry loop: one refusal, one spawn.
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('a Restart: the new view spawns through the same pty:spawn, and its refusal is said the same way', async () => {
    mount(claudeSession())
    await settle()
    await act(async () => { settles[0].resolve(undefined) })
    await restartTo(claudeSession(), 'b')
    expect(spawn).toHaveBeenCalledTimes(2)
    await act(async () => { settles[1].resolve(claudeOff) })
    await settle()
    expect(termLines()).toContain(OFF_TAB)
    expect(exitedMarks()).toHaveLength(1)
    expect(removeSession).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(2)
  })

  it("the state main could not read reads once, plainly, with what to do", async () => {
    mount(claudeSession())
    await settle()
    await act(async () => { settles[0].resolve({ started: false, refused: { code: 'provider-state-unknown', providerId: 'claude', message: 'This app could not read whether Claude Code is on. Check Settings, Accounts.' } }) })
    await settle()
    expect(termLines()).toContain('Not started. This app could not read whether Claude Code is on. Check Settings, Accounts, then Restart this tab.')
  })

  it('a Codex session refused because Codex is off says so, in the same words', async () => {
    mount(codexSession({ providerAccountId: 'acc-work' }))
    await settle()
    await act(async () => { settles[0].resolve(codexOff) })
    await settle()
    expect(termLines()).toContain(CODEX_OFF_TAB)
    expect(exitedMarks()).toHaveLength(1)
    expect(removeSession).not.toHaveBeenCalled()
  })

  it('a restored Codex session while Codex is off asks no sign-in question: it goes to main, and the tab says Codex is off', async () => {
    useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [provider({ providerId: 'codex', displayName: 'Codex', enabled: false, preference: 'off' })] }), loaded: true })
    mount(codexSession({ providerAccountId: 'acc-local' }))
    await settle()
    expect(useLaunchAckStore.getState().queue).toHaveLength(0)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][1].acknowledgeRealmOnly).toBeUndefined()
    // Its own account still rides along: should main have Codex on already,
    // the bound session runs on it, never on the default.
    expect(spawn.mock.calls[0][1].providerAccountId).toBe('acc-local')
    await act(async () => { settles[0].resolve(codexOff) })
    await settle()
    expect(termLines()).toContain(CODEX_OFF_TAB)
    expect(termLines()).not.toContain('not confirmed')
  })

  it('an unbound Codex session while Codex is off names no account (the provider default, as before)', async () => {
    useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [provider({ providerId: 'codex', displayName: 'Codex', enabled: false, preference: 'off' })] }), loaded: true })
    mount(codexSession())
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0][1].providerAccountId).toBeUndefined()
    expect(spawn.mock.calls[0][1].acknowledgeRealmOnly).toBeUndefined()
  })

  it('...while with Codex on, the same session asks first (the control)', async () => {
    mount(codexSession({ providerAccountId: 'acc-local' }))
    await settle()
    expect(useLaunchAckStore.getState().queue).toHaveLength(1)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('a Claude session while Claude Code is off opens no account picker, even with several accounts: it goes to main', async () => {
    profilesState.profiles = [{ id: 'p1' }, { id: 'p2' }]
    useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [provider({ providerId: 'claude', displayName: 'Claude Code', enabled: false, preference: 'off' })] }), loaded: true })
    mount(claudeSession())
    await settle()
    expect(useAccountGateStore.getState().queue).toHaveLength(0)
    expect(spawn).toHaveBeenCalledTimes(1)
    await act(async () => { settles[0].resolve(claudeOff) })
    await settle()
    expect(termLines()).toContain(OFF_TAB)
  })

  it('...while with Claude Code on, several accounts open the picker first (the control)', async () => {
    profilesState.profiles = [{ id: 'p1' }, { id: 'p2' }]
    mount(claudeSession())
    await settle()
    expect(useAccountGateStore.getState().queue).toHaveLength(1)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('an SSH tab while Claude Code is off never shows the "Connecting..." card, before main answers or after', async () => {
    settingsState.settings.claudeEnabled = false
    mountSsh()
    await settle()
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(overlay()).toBeNull()
    await act(async () => { settles[0].resolve(claudeOff) })
    await settle()
    expect(termLines()).toContain(OFF_TAB)
    expect(overlay()).toBeNull()
    expect(removeSession).not.toHaveBeenCalled()
  })

  it('an SSH tab main refused while the renderer still thought Claude Code was on: the card goes once main answers', async () => {
    mountSsh()
    await settle()
    await act(async () => { settles[0].resolve(claudeOff) })
    await settle()
    expect(termLines()).toContain(OFF_TAB)
    expect(overlay()).toBeNull()
  })

  it('an SSH tab with Claude Code on shows its card as before (the control)', async () => {
    mountSsh()
    await settle()
    expect(overlay()).not.toBeNull()
  })

  it('a nothing-started answer without a refusal still reads as a cancelled launch', async () => {
    mount(claudeSession())
    await settle()
    await act(async () => { settles[0].resolve({ started: false }) })
    expect(termLines()).toContain('[The launch was cancelled before the session started]')
    expect(termLines()).not.toContain('Not started.')
  })
})
