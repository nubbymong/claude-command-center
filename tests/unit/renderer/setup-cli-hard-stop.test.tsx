// @vitest-environment jsdom
/**
 * Phase 7 item B — first-run setup HARD STOPS when the Claude Code CLI is
 * missing.
 *
 * Before this, step 2 spawned its setup PTY unconditionally. On a machine with
 * no `claude` binary that PTY printed "'claude' is not recognized", the
 * "Skip & Continue" button enabled itself the moment the spawn resolved, and
 * the user landed in an app where no session can ever start and nothing says
 * why. `isCliReady()` could not catch it: it asks whether the install folder is
 * TRUSTED, and answers "no" identically for "binary missing" and "binary there,
 * folder not trusted yet".
 *
 * The gate is now a real probe (`setup.probeCli`, main-side `where` /
 * `command -v`), run BEFORE the terminal opens. These tests pin the three
 * things that make it a stop rather than a warning: no PTY is spawned, there is
 * no way forward, and Retry re-probes.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const setup = {
  getDefaultDataDir: vi.fn(async () => 'C:\\data'),
  getResourcesDir: vi.fn(async () => 'C:\\resources'),
  selectDataDir: vi.fn(async () => null),
  selectResourcesDir: vi.fn(async () => null),
  setDataDir: vi.fn(async () => true),
  setResourcesDir: vi.fn(async () => true),
  probeCli: vi.fn(async () => ({ installed: false, probe: 'where claude' })),
  spawnCliSetup: vi.fn(async () => '__cli_setup__'),
  killCliSetup: vi.fn(async () => true),
}
const pty = {
  onData: vi.fn(() => () => {}),
  onExit: vi.fn(() => () => {}),
  write: vi.fn(),
}
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, setup, pty }

// xterm needs a real canvas/DOM measurement it cannot get in jsdom; the dialog
// only opens a terminal on the HAPPY path, and these tests care about the
// blocked one, but step 2's effect constructs the Terminal either way.
vi.mock('@xterm/xterm', () => ({ Terminal: class { cols = 80; rows = 24; loadAddon() {} open() {} write() {} onData() {} dispose() {} } }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

const { default: SetupDialog } = await import('../../../src/renderer/components/SetupDialog')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  setup.probeCli.mockClear()
  setup.spawnCliSetup.mockClear()
  setup.killCliSetup.mockClear()
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} }
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

async function renderAtStep2(onComplete = vi.fn()) {
  await act(async () => {
    root.render(React.createElement(SetupDialog, { onComplete, initialStep: 2 }))
  })
  // The default-dirs promise and the probe both settle a microtask later.
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return onComplete
}

describe('first-run setup: the Claude CLI gate', () => {
  it('a missing CLI stops the flow: the notice names it, the install command and Retry are there', async () => {
    setup.probeCli.mockResolvedValue({ installed: false, probe: 'where claude' })
    await renderAtStep2()

    expect(setup.probeCli).toHaveBeenCalled()
    expect(byTest('setup-cli-missing')).not.toBeNull()
    expect(byTest('setup-cli-install-command')!.textContent).toBe('npm install -g @anthropic-ai/claude-code')
    expect(byTest('setup-cli-retry')).not.toBeNull()
    expect(container.textContent).toContain('Claude Code is not installed')
  })

  it('spawns NO setup PTY while blocked', async () => {
    setup.probeCli.mockResolvedValue({ installed: false, probe: 'where claude' })
    await renderAtStep2()
    expect(setup.spawnCliSetup).not.toHaveBeenCalled()
  })

  it('offers no way past: no Skip, no Finish, and setup never completes', async () => {
    setup.probeCli.mockResolvedValue({ installed: false, probe: 'where claude' })
    const onComplete = await renderAtStep2()

    expect(byTest('setup-cli-skip')).toBeNull()
    expect(byTest('setup-cli-finish')).toBeNull()
    expect(onComplete).not.toHaveBeenCalled()
    expect(setup.killCliSetup).not.toHaveBeenCalled()
  })

  it('Retry re-probes, and a CLI that has appeared unblocks the step', async () => {
    setup.probeCli.mockResolvedValue({ installed: false, probe: 'where claude' })
    await renderAtStep2()
    expect(byTest('setup-cli-missing')).not.toBeNull()

    setup.probeCli.mockResolvedValue({ installed: true, path: 'C:\\bin\\claude.cmd', probe: 'where claude.cmd' })
    await act(async () => { byTest('setup-cli-retry')!.click() })
    await act(async () => { await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    expect(setup.probeCli).toHaveBeenCalledTimes(2)
    expect(byTest('setup-cli-missing')).toBeNull()
  })

  it('an errored probe is treated as missing (fail closed), not waved through', async () => {
    setup.probeCli.mockRejectedValueOnce(new Error('IPC exploded'))
    await renderAtStep2()
    expect(byTest('setup-cli-missing')).not.toBeNull()
    expect(byTest('setup-cli-probe-detail')!.textContent).toContain('IPC exploded')
    expect(setup.spawnCliSetup).not.toHaveBeenCalled()
  })

  it('the happy path is untouched: an installed CLI opens the terminal step and spawns the PTY', async () => {
    setup.probeCli.mockResolvedValue({ installed: true, path: '/usr/local/bin/claude', probe: 'which claude' })
    await renderAtStep2()

    expect(byTest('setup-cli-missing')).toBeNull()
    expect(container.textContent).toContain('Claude CLI Setup')
    // The spawn is driven by requestAnimationFrame + a container measurement
    // jsdom cannot provide, so the PTY itself is not asserted here; what
    // matters is that the gate no longer stands in its way.
    expect(byTest('setup-cli-checking')).toBeNull()
  })
})
