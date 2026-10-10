// @vitest-environment jsdom
/**
 * First-run setup when Claude Code is not installed (owner decisions D1 to D4,
 * 2026-10-10; ADR-024): the screen lists main's install commands for Claude
 * Code, Anthropic's native installer first and npm second, each with Run it
 * for me and Copy. Run it for me asks first (for the installer, naming the
 * host it downloads its script from), then runs main's line in a terminal on
 * this screen, started exactly as the install tab is (shell only, never
 * elevated, no command secrets). The line ends its shell when the command
 * ends, and setup then checks again: found, it goes on to the Claude Code
 * setup terminal; not found, it says so with the exit code and what to do.
 * The restart advice appears only when a check still finds nothing.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { InstallRecipeView } from '../../../src/shared/providers'
import { claudeInstallRecipes } from '../../../src/main/providers/claude/install-recipes'
import { installRecipeView } from '../../../src/main/providers/core/recipe-run-line'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const RECIPES: InstallRecipeView[] = claudeInstallRecipes('win32').map((r) => installRecipeView(r, 'win32'))
const NATIVE = RECIPES[0]
const NPM = RECIPES[1]

const setup = {
  getDefaultDataDir: vi.fn(async () => 'C:\\data'),
  getResourcesDir: vi.fn(async () => 'C:\\resources'),
  selectDataDir: vi.fn(async () => null),
  selectResourcesDir: vi.fn(async () => null),
  setDataDir: vi.fn(async () => true),
  setResourcesDir: vi.fn(async () => true),
  probeCli: vi.fn(async () => ({ installed: false, probe: 'PATH walk' })),
  spawnCliSetup: vi.fn(async () => '__cli_setup__'),
  killCliSetup: vi.fn(async () => true),
}
const exits = new Map<string, (code: number) => void>()
const order: string[] = []
const pty = {
  onData: vi.fn(() => () => {}),
  onExit: vi.fn((id: string, cb: (code: number) => void) => { order.push(`onExit ${id}`); exits.set(id, cb); return () => { exits.delete(id) } }),
  write: vi.fn(),
  spawn: vi.fn(async (id: string) => { order.push(`spawn ${id}`); return { started: true } }),
  kill: vi.fn(),
}
const providerAccounts = { installRecipes: vi.fn(async () => RECIPES) }
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, setup, pty, providerAccounts }
const writeText = vi.fn(async () => undefined)
Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true })

vi.mock('@xterm/xterm', () => ({ Terminal: class { cols = 80; rows = 24; loadAddon() {} open() {} write() {} writeln() {} onData() {} dispose() {} focus() {} } }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

// The terminal opens once its container has a size, which jsdom never gives.
const sized = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
const sizedH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 })
afterAll(() => {
  if (sized) Object.defineProperty(HTMLElement.prototype, 'clientWidth', sized)
  if (sizedH) Object.defineProperty(HTMLElement.prototype, 'clientHeight', sizedH)
})

const { default: SetupDialog } = await import('../../../src/renderer/components/SetupDialog')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  for (const f of [...Object.values(setup), ...Object.values(pty), providerAccounts.installRecipes, writeText]) f.mockClear()
  setup.probeCli.mockResolvedValue({ installed: false, probe: 'PATH walk' })
  providerAccounts.installRecipes.mockResolvedValue(RECIPES)
  exits.clear()
  order.length = 0
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} }
  ;(globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(0), 0)
  ;(window as unknown as { electronPlatform?: string }).electronPlatform = 'win32'
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
async function settle() {
  for (let i = 0; i < 8; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}
async function renderMissing() {
  await act(async () => { root.render(React.createElement(SetupDialog, { onComplete: vi.fn(), initialStep: 2 })) })
  await settle()
}
async function click(id: string) {
  await act(async () => { byTest(id)!.click() })
  await settle()
}
async function startInstall(r: InstallRecipeView) {
  await click(`setup-recipe-run-${r.id}`)
  await click(`setup-recipe-confirm-run-${r.id}`)
  const id = pty.spawn.mock.calls[0]?.[0] as string
  return id
}

describe('first-run setup: installing Claude Code from the setup screen', () => {
  it("lists Anthropic's native installer first, then npm, each with Run it for me and Copy", async () => {
    await renderMissing()
    expect(providerAccounts.installRecipes).toHaveBeenCalledWith('claude')
    const shown = [...byTest('setup-recipes-install')!.querySelectorAll('[data-testid^="setup-recipe-command-"]')].map((c) => c.textContent)
    expect(shown).toEqual(['irm https://claude.ai/install.ps1 | iex', 'npm.cmd install -g @anthropic-ai/claude-code'])
    for (const r of RECIPES) {
      expect(byTest(`setup-recipe-run-${r.id}`)!.textContent, r.id).toBe('Run it for me')
      expect(byTest(`setup-recipe-copy-${r.id}`)!.textContent, r.id).toBe('Copy')
    }
    expect(byTest('setup-recipes-install')!.textContent).toContain('From Anthropic')
    // The screen's own ways out stay.
    expect(byTest('setup-cli-retry')).not.toBeNull()
    expect(byTest('setup-cli-back')).not.toBeNull()
  })

  it('Copy copies the command as shown and starts nothing', async () => {
    await renderMissing()
    await click(`setup-recipe-copy-${NPM.id}`)
    expect(writeText).toHaveBeenCalledWith('npm.cmd install -g @anthropic-ai/claude-code')
    expect(pty.spawn).not.toHaveBeenCalled()
  })

  it('Run it for me on the native installer asks first: it names claude.ai, says it downloads and runs a script, and shows the line; Cancel starts nothing', async () => {
    await renderMissing()
    await click(`setup-recipe-run-${NATIVE.id}`)
    expect(byTest(`setup-recipe-confirm-text-${NATIVE.id}`)!.textContent).toBe(
      'This downloads a script from claude.ai and runs it. Run this in a terminal on this screen? It types the line below, and setup checks again when the command ends.',
    )
    expect(byTest(`setup-recipe-run-line-${NATIVE.id}`)!.textContent).toBe('irm https://claude.ai/install.ps1 | iex; exit $LASTEXITCODE')
    await click(`setup-recipe-cancel-${NATIVE.id}`)
    expect(byTest(`setup-recipe-confirm-${NATIVE.id}`)).toBeNull()
    expect(pty.spawn).not.toHaveBeenCalled()
  })

  it("Run it starts one terminal on this screen with the install tab's options, listening before it starts; never the setup terminal", async () => {
    await renderMissing()
    const id = await startInstall(NATIVE)
    expect(byTest('setup-cli-install')).not.toBeNull()
    expect(pty.spawn).toHaveBeenCalledTimes(1)
    expect(pty.spawn).toHaveBeenCalledWith(id, {
      cols: 80, rows: 24, shellOnly: true, provider: 'claude',
      terminalOptions: { command: NATIVE.runLine, elevated: false, noCommandSecrets: true },
    })
    expect(order.indexOf(`onExit ${id}`)).toBeGreaterThanOrEqual(0)
    expect(order.indexOf(`onExit ${id}`)).toBeLessThan(order.indexOf(`spawn ${id}`))
    expect(setup.spawnCliSetup).not.toHaveBeenCalled()
  })

  it('when the command ends and Claude Code is found, setup goes on to the Claude Code setup terminal', async () => {
    await renderMissing()
    const id = await startInstall(NATIVE)
    const probes = setup.probeCli.mock.calls.length
    setup.probeCli.mockResolvedValue({ installed: true, path: 'C:\\Users\\u\\.local\\bin\\claude.exe', probe: 'PATH walk' })
    await act(async () => { exits.get(id)!(0) })
    await settle()
    expect(setup.probeCli.mock.calls.length).toBe(probes + 1)
    expect(byTest('setup-cli-install')).toBeNull()
    expect(byTest('setup-cli-missing')).toBeNull()
    expect(container.textContent).toContain('Claude CLI Setup')
    expect(setup.spawnCliSetup).toHaveBeenCalledTimes(1)
  })

  it('when it ends and Claude Code is still not found, the screen says so with the exit code and what to do; Retry and Back stay', async () => {
    await renderMissing()
    const id = await startInstall(NPM)
    const reads = providerAccounts.installRecipes.mock.calls.length
    await act(async () => { exits.get(id)!(1) })
    await settle()
    expect(byTest('setup-cli-install')).not.toBeNull()
    expect(byTest('setup-cli-install-ended')!.textContent).toBe(
      'The command ended with exit code 1, but Claude Code was still not found. The terminal shows what happened. If it installed without an error, quit AI Code Conductor and start it again so it sees the new PATH.',
    )
    expect(providerAccounts.installRecipes.mock.calls.length).toBeGreaterThan(reads)
    expect((byTest('setup-cli-install-retry') as HTMLButtonElement).disabled).toBe(false)
    const probes = setup.probeCli.mock.calls.length
    await click('setup-cli-install-retry')
    expect(setup.probeCli.mock.calls.length).toBe(probes + 1)
    // An ended command is not killed on the way out.
    await click('setup-cli-install-back')
    expect(pty.kill).not.toHaveBeenCalled()
    expect(byTest('setup-cli-missing')).not.toBeNull()
  })

  it('a command that ends with code 0 is not said to have failed', async () => {
    await renderMissing()
    const id = await startInstall(NATIVE)
    await act(async () => { exits.get(id)!(0) })
    await settle()
    expect(byTest('setup-cli-install-ended')!.textContent).toMatch(/^The command ended, but Claude Code was still not found\./)
  })

  it('Retry is off while the command runs; Back stops it and checks again', async () => {
    await renderMissing()
    const id = await startInstall(NPM)
    expect((byTest('setup-cli-install-retry') as HTMLButtonElement).disabled).toBe(true)
    const probes = setup.probeCli.mock.calls.length
    await click('setup-cli-install-back')
    expect(pty.kill).toHaveBeenCalledWith(id)
    expect(setup.probeCli.mock.calls.length).toBe(probes + 1)
    expect(byTest('setup-cli-install')).toBeNull()
    expect(byTest('setup-cli-missing')).not.toBeNull()
  })

  it('leaving setup while the command runs stops it', async () => {
    await renderMissing()
    const id = await startInstall(NPM)
    act(() => { root.unmount() })
    expect(pty.kill).toHaveBeenCalledWith(id)
    root = createRoot(container)
  })

  it('the restart advice is not shown before anything was tried; a Retry that still finds nothing shows it', async () => {
    await renderMissing()
    expect(container.textContent).not.toContain('quit AI Code Conductor')
    await click('setup-cli-retry')
    expect(byTest('setup-cli-still-missing')!.textContent).toBe(
      'Claude Code was still not found. If you installed it, quit AI Code Conductor and start it again so it sees the new PATH.',
    )
  })

  it('npm needs Node.js: its Run it for me is off and says so; Copy still works; the native installer still runs', async () => {
    providerAccounts.installRecipes.mockResolvedValue([NATIVE, { ...NPM, needsNode: true }])
    await renderMissing()
    const run = byTest(`setup-recipe-run-${NPM.id}`) as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(byTest(`setup-recipe-needs-node-${NPM.id}`)!.textContent).toBe('Needs Node.js, which was not found on this computer.')
    await click(`setup-recipe-copy-${NPM.id}`)
    expect(writeText).toHaveBeenCalledWith(NPM.displayCommand)
    expect((byTest(`setup-recipe-run-${NATIVE.id}`) as HTMLButtonElement).disabled).toBe(false)
  })

  it('when main cannot give the commands, the screen still shows the npm command to copy', async () => {
    providerAccounts.installRecipes.mockRejectedValue(new Error('ipc down'))
    await renderMissing()
    expect(byTest('setup-recipes-install')).toBeNull()
    expect(byTest('setup-cli-install-command')!.textContent).toBe('npm.cmd install -g @anthropic-ai/claude-code')
  })
})
