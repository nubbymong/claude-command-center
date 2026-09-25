// @vitest-environment jsdom
/**
 * WP2: the first-run CLI setup terminal runs Claude Code itself (its
 * folder-trust prompt), so main refuses it while Claude Code is off
 * (src/main/provider-launch-gate.ts). The setup terminal says why, in main's
 * own words, and the step is not held open waiting for a PTY that will never
 * start: Skip for now goes on without it.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const OFF = 'Claude Code is off. Turn it on in Settings, Accounts.'
const setup = {
  getDefaultDataDir: vi.fn(async () => 'C:\\data'),
  getResourcesDir: vi.fn(async () => 'C:\\resources'),
  selectDataDir: vi.fn(async () => null),
  selectResourcesDir: vi.fn(async () => null),
  setDataDir: vi.fn(async () => true),
  setResourcesDir: vi.fn(async () => true),
  probeCli: vi.fn(async () => ({ installed: true, path: 'C:\\bin\\claude.cmd', probe: 'where claude.cmd' })),
  spawnCliSetup: vi.fn(async (): Promise<unknown> => ({ refused: { code: 'provider-off', providerId: 'claude', message: OFF } })),
  killCliSetup: vi.fn(async () => true),
}
const pty = { onData: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}), write: vi.fn() }
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, setup, pty }

const lines = vi.hoisted(() => [] as string[])
vi.mock('@xterm/xterm', () => ({
  Terminal: class { cols = 80; rows = 24; loadAddon() {} open() {} focus() {} write() {} writeln(s: string) { lines.push(s) } onData() {} dispose() {} },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

const { default: SetupDialog } = await import('../../../src/renderer/components/SetupDialog')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  lines.length = 0
  setup.spawnCliSetup.mockClear()
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} }
  // The terminal opens once its container has a size, on an animation frame.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 })
  ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  delete (HTMLElement.prototype as any).clientWidth
  delete (HTMLElement.prototype as any).clientHeight
})

async function renderAtStep2() {
  await act(async () => { root.render(React.createElement(SetupDialog, { onComplete: vi.fn(), initialStep: 2 })) })
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() })
}
const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null

describe('the CLI setup terminal while Claude Code is off', () => {
  it("main's refusal is said in the setup terminal; Skip for now is there, Finish is not offered", async () => {
    await renderAtStep2()
    expect(setup.spawnCliSetup).toHaveBeenCalledTimes(1)
    expect(lines).toContain(OFF)
    expect(byTest('setup-cli-skip')).not.toBeNull()
    expect(byTest('setup-cli-finish')!.disabled).toBe(true)
  })

  it('a terminal that started says nothing of the kind, and Finish is offered', async () => {
    setup.spawnCliSetup.mockResolvedValueOnce('__cli_setup__')
    await renderAtStep2()
    expect(lines).not.toContain(OFF)
    expect(byTest('setup-cli-finish')!.disabled).toBe(false)
  })
})
