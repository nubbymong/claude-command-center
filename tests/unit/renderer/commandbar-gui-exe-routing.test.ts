// @vitest-environment jsdom
/**
 * #379 routing: what a command button does once we know what its program IS.
 *
 * The bar's job is to decide, not to detect. These pin the decision table:
 *
 *   prompt button              -> type it, never probe (no program is started)
 *   shell + console/unresolved -> type it, exactly as before
 *   shell + GUI, no policy     -> ask; type NOTHING until the user answers
 *   shell + GUI, policy capture-> run console-less, show the log
 *   shell + GUI, policy termin.-> type it, and arm the repaint sweep (fix E)
 *   probe unavailable/throws   -> type it (the warning is never a precondition)
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const updateCommand = vi.fn()
let COMMANDS: any[] = []

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) =>
    sel({ sessions: [{ id: 's-1', label: 't', workingDirectory: 'C:\\work', color: '#89b4fa', sessionType: 'local', provider: 'claude', model: 'sonnet' }],
      activeSessionId: 's-1', updateSession: vi.fn() }),
}))
vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({
    commands: COMMANDS, sections: [], addCommand: vi.fn(), updateCommand, removeCommand: vi.fn(),
    reorderCommands: vi.fn(), updateSection: vi.fn(), removeSection: vi.fn(), reorderSections: vi.fn(),
  }),
}))
vi.mock('../../../src/renderer/stores/commandBarStore', () => ({
  useCommandBarStore: (sel: any) => sel({ state: { collapsedSectionIds: [] }, toggleSection: vi.fn() }),
}))
vi.mock('../../../src/renderer/stores/webviewStore', () => ({
  useWebviewStore: (sel: any) => sel({ startActivation: vi.fn(() => 0), markAvailable: vi.fn(), markFailed: vi.fn(), bySessionId: {} }),
  pollUrlForContent: vi.fn(() => Promise.resolve(false)),
  probeWebviewUrls: vi.fn(() => Promise.resolve(false)),
}))
vi.mock('../../../src/renderer/stores/tipsStore', () => ({ trackUsage: vi.fn() }))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))
vi.mock('../../../src/renderer/components/ScreenshotButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/AgentCanvasButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/WebviewButton', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/CommandDialog', () => ({ default: () => null }))
vi.mock('../../../src/renderer/components/ToolbarPopup', () => ({ default: () => null }))

const scheduleBleedRepaints = vi.fn(() => 1)
vi.mock('../../../src/renderer/components/terminal/repaintRegistry', () => ({
  scheduleBleedRepaints: (...a: unknown[]) => scheduleBleedRepaints(...(a as [])),
}))

const ptyWrite = vi.fn()
const probe = vi.fn()
const runCaptured = vi.fn()
const releaseRun = vi.fn(async () => true)
const cancelRun = vi.fn(async () => true)
const exeApi = { probe, runCaptured, releaseRun, cancelRun, onRunData: () => () => {}, onRunExit: () => () => {} }
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  pty: { write: ptyWrite },
  credentials: { save: vi.fn(), delete: vi.fn() },
  exe: exeApi,
}
;(globalThis as any).window.electronPlatform = 'win32'

const { default: CommandBar } = await import('../../../src/renderer/components/CommandBar')
const { __clearProbeCache } = await import('../../../src/renderer/lib/gui-exe-probe-cache')

let container: HTMLDivElement
let root: Root

/** A shell button (target partner => effectiveKind 'shell'). */
const shellCmd = (over: Record<string, unknown> = {}) => ({
  id: 'abc123', label: 'Slice', prompt: 'bambu-studio', scope: 'global' as const,
  target: 'partner' as const, kind: 'shell' as const, defaultArgs: ['--debug', '2'], ...over,
})

function mount(commands: any[]) {
  COMMANDS = commands
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  act(() => {
    root.render(React.createElement(CommandBar, {
      sessionId: 's-1', parentSessionId: 's-1', partnerEnabled: true, partnerSessionId: 's-1-partner', isPartnerActive: true,
    } as never))
  })
}

const click = (label: string) => {
  const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(label)) as HTMLButtonElement
  act(() => { btn.click() })
}

/** Let the probe promise and its .then chain flush. */
const settle = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

beforeEach(() => {
  ptyWrite.mockClear(); probe.mockReset(); runCaptured.mockReset()
  releaseRun.mockClear(); cancelRun.mockClear()
  updateCommand.mockClear(); scheduleBleedRepaints.mockClear()
  __clearProbeCache()
  // The cache would otherwise carry a previous test's answer into this one and
  // make the decision synchronously — a false green for the async cases.
  ;(globalThis as any).window.electronAPI.exe = exeApi
})
afterEach(() => { act(() => { root.unmount() }); container.remove() })

describe('a prompt button is never probed', () => {
  it('types straight into the agent — no program is being started', async () => {
    mount([{ id: 'p1', label: 'Explain', prompt: 'explain this', scope: 'global', target: 'claude', kind: 'prompt' }])
    click('Explain')
    expect(ptyWrite).toHaveBeenCalledTimes(1)
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('a shell button whose program is harmless', () => {
  it('types it, exactly as before, for a console-subsystem exe', async () => {
    probe.mockResolvedValue({ status: 'console', token: 'git', exePath: 'C:\\bin\\git.exe' })
    mount([shellCmd({ prompt: 'git' })])
    click('Slice')
    await settle()
    expect(ptyWrite).toHaveBeenCalledTimes(1)
    expect(scheduleBleedRepaints).not.toHaveBeenCalled()
  })

  it('types it when the program cannot be resolved at all', async () => {
    probe.mockResolvedValue({ status: 'unresolved', token: '$env:X', exePath: null })
    mount([shellCmd()])
    click('Slice')
    await settle()
    expect(ptyWrite).toHaveBeenCalledTimes(1)
  })

  it('types it off Windows', async () => {
    probe.mockResolvedValue({ status: 'not-windows', token: null, exePath: null })
    mount([shellCmd()])
    click('Slice')
    await settle()
    expect(ptyWrite).toHaveBeenCalledTimes(1)
  })

  it('types it when the probe itself fails — the warning is not a precondition', async () => {
    probe.mockRejectedValue(new Error('main is gone'))
    mount([shellCmd()])
    click('Slice')
    await settle()
    expect(ptyWrite).toHaveBeenCalledTimes(1)
  })
})

describe('a shell button whose program is a GUI-subsystem exe', () => {
  const gui = { status: 'gui', token: 'bambu-studio', exePath: 'C:\\tools\\bambu-studio.exe' }

  it('types NOTHING and asks first', async () => {
    probe.mockResolvedValue(gui)
    mount([shellCmd()])
    click('Slice')
    await settle()
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(container.querySelector('[data-ux-id="gui-exe-dialog"]')).toBeTruthy()
    // The resolved path is shown, so the user can see WHICH program this is.
    expect(container.textContent).toContain('C:\\tools\\bambu-studio.exe')
  })

  it('"Run in the terminal anyway" types it AND arms the repaint sweep (fix E)', async () => {
    probe.mockResolvedValue(gui)
    mount([shellCmd()])
    click('Slice')
    await settle()

    const btn = container.querySelector('[data-ux-id="gui-exe-terminal"]') as HTMLButtonElement
    act(() => { btn.click() })

    expect(ptyWrite).toHaveBeenCalledTimes(1)
    expect(ptyWrite.mock.calls[0][1]).toBe('bambu-studio --debug 2\r')
    expect(scheduleBleedRepaints).toHaveBeenCalledWith('s-1-partner')
    // Not remembered unless asked.
    expect(updateCommand).not.toHaveBeenCalled()
  })

  it('"Capture the output" runs it console-less and types nothing into the pty', async () => {
    probe.mockResolvedValue(gui)
    runCaptured.mockResolvedValue({ runId: 'run-1', exePath: gui.exePath })
    mount([shellCmd()])
    click('Slice')
    await settle()

    const btn = container.querySelector('[data-ux-id="gui-exe-capture"]') as HTMLButtonElement
    await act(async () => { btn.click(); await Promise.resolve(); await Promise.resolve() })

    expect(runCaptured).toHaveBeenCalledWith({ command: 'bambu-studio --debug 2', cwd: 'C:\\work' })
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(container.querySelector('[data-ux-id="captured-run-dialog"]')).toBeTruthy()
  })

  it('remembers the choice only when asked to', async () => {
    probe.mockResolvedValue(gui)
    runCaptured.mockResolvedValue({ runId: 'run-1', exePath: gui.exePath })
    mount([shellCmd()])
    click('Slice')
    await settle()

    act(() => { (container.querySelector('[data-ux-id="gui-exe-remember"]') as HTMLInputElement).click() })
    await act(async () => {
      ;(container.querySelector('[data-ux-id="gui-exe-capture"]') as HTMLButtonElement).click()
      await Promise.resolve()
    })
    expect(updateCommand).toHaveBeenCalledWith('abc123', { guiExePolicy: 'capture' })
  })

  it('Cancel types nothing at all', async () => {
    probe.mockResolvedValue(gui)
    mount([shellCmd()])
    click('Slice')
    await settle()
    act(() => { (container.querySelector('[data-ux-id="gui-exe-cancel"]') as HTMLButtonElement).click() })
    expect(ptyWrite).not.toHaveBeenCalled()
    expect(runCaptured).not.toHaveBeenCalled()
    expect(container.querySelector('[data-ux-id="gui-exe-dialog"]')).toBeNull()
  })

  it('a refused captured run falls back to the pty AND SAYS SO', async () => {
    probe.mockResolvedValue(gui)
    // The file changed between the probe and the spawn, or it was never a PE.
    runCaptured.mockResolvedValue({ runId: null, exePath: gui.exePath, error: 'not a GUI-subsystem program' })
    mount([shellCmd({ guiExePolicy: 'capture' })])
    click('Slice')
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve() })

    expect(ptyWrite).toHaveBeenCalledTimes(1)
    // The user explicitly asked NOT to have their pane painted over. Falling
    // back silently (a console.warn) was the first version's MINOR-3.
    const panel = container.querySelector('[data-ux-id="captured-run-refused"]')
    expect(panel).toBeTruthy()
    expect(panel?.textContent).toContain('not a GUI-subsystem program')
  })

  it('warns that a captured run has no shell, naming the operators in the line', async () => {
    probe.mockResolvedValue(gui)
    mount([shellCmd({ defaultArgs: ['--debug', '2', '>', 'log.txt'] })])
    click('Slice')
    await settle()
    const note = container.querySelector('[data-ux-id="gui-exe-noshell"]')
    expect(note?.textContent).toContain('without a shell')
    expect(note?.textContent).toContain('>')
    expect(note?.textContent).toMatch(/literal argument/)
  })

  it('closing the log panel RELEASES the capture and does not kill the program', async () => {
    probe.mockResolvedValue(gui)
    runCaptured.mockResolvedValue({ runId: 'run-1', exePath: gui.exePath })
    mount([shellCmd({ guiExePolicy: 'capture' })])
    click('Slice')
    await act(async () => { for (let i = 0; i < 6; i++) await Promise.resolve() })

    const close = container.querySelector('[data-ux-id="captured-run-close"]') as HTMLButtonElement
    act(() => { close.click() })

    expect(releaseRun).toHaveBeenCalledWith('run-1')
    expect(cancelRun).not.toHaveBeenCalled()
  })
})

describe('press ordering (#379 MAJOR-6)', () => {
  it('two rapid presses reach the pty in press order even when the first must wait', async () => {
    // sendCommand became async for shell buttons; the write used to be strictly
    // ordered and has to stay that way. The first press waits on a probe, so the
    // second must queue behind it rather than overtaking.
    let releaseFirst: (v: unknown) => void = () => {}
    const firstProbe = new Promise((r) => { releaseFirst = r })
    probe
      .mockImplementationOnce(async () => { await firstProbe; return { status: 'console', token: 'a', exePath: 'C:\\a.exe' } })
      .mockImplementation(async () => ({ status: 'console', token: 'b', exePath: 'C:\\b.exe' }))

    mount([
      shellCmd({ id: 'aaa111', label: 'First', prompt: 'first-tool', defaultArgs: [] }),
      shellCmd({ id: 'bbb222', label: 'Second', prompt: 'second-tool', defaultArgs: [] }),
    ])

    click('First')
    click('Second')
    expect(ptyWrite).not.toHaveBeenCalled() // both are waiting

    await act(async () => { releaseFirst(null); for (let i = 0; i < 8; i++) await Promise.resolve() })

    expect(ptyWrite).toHaveBeenCalledTimes(2)
    expect(ptyWrite.mock.calls[0][1]).toBe('first-tool\r')
    expect(ptyWrite.mock.calls[1][1]).toBe('second-tool\r')
  })

  it('a repeat press decides from cache, synchronously, keeping the old ordering guarantee', async () => {
    probe.mockResolvedValue({ status: 'console', token: 'git', exePath: 'C:\\bin\\git.exe' })
    mount([shellCmd({ prompt: 'git', defaultArgs: ['status'] })])

    click('Slice')
    await settle()
    expect(ptyWrite).toHaveBeenCalledTimes(1)
    expect(probe).toHaveBeenCalledTimes(1)

    // Second press: no await anywhere, and no second IPC round trip.
    click('Slice')
    expect(ptyWrite).toHaveBeenCalledTimes(2)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})

describe('when the probe is not available at all', () => {
  it('types synchronously, exactly as the button always did', () => {
    // Deliberate rather than accidental (review MINOR-8): the claim is that an
    // older preload, or any harness without `exe`, keeps the original path.
    const saved = (globalThis as any).window.electronAPI.exe
    delete (globalThis as any).window.electronAPI.exe
    try {
      mount([shellCmd()])
      click('Slice')
      // No await: the write must already have happened.
      expect(ptyWrite).toHaveBeenCalledTimes(1)
      expect(ptyWrite.mock.calls[0][1]).toBe('bambu-studio --debug 2\r')
      expect(probe).not.toHaveBeenCalled()
    } finally {
      ;(globalThis as any).window.electronAPI.exe = saved
    }
  })
})

describe('a remembered policy skips the question', () => {
  it("policy 'terminal' types immediately and never probes", async () => {
    mount([shellCmd({ guiExePolicy: 'terminal' })])
    click('Slice')
    expect(probe).not.toHaveBeenCalled()
    expect(ptyWrite).toHaveBeenCalledTimes(1)
    expect(scheduleBleedRepaints).toHaveBeenCalledWith('s-1-partner')
  })

  it("policy 'capture' still probes, then captures without asking", async () => {
    probe.mockResolvedValue({ status: 'gui', token: 'bambu-studio', exePath: 'C:\\tools\\bambu-studio.exe' })
    runCaptured.mockResolvedValue({ runId: 'run-9', exePath: 'C:\\tools\\bambu-studio.exe' })
    mount([shellCmd({ guiExePolicy: 'capture' })])
    click('Slice')
    await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() })
    expect(container.querySelector('[data-ux-id="gui-exe-dialog"]')).toBeNull()
    expect(runCaptured).toHaveBeenCalledTimes(1)
    expect(ptyWrite).not.toHaveBeenCalled()
  })
})
