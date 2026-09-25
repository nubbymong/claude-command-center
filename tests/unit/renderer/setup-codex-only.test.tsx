// @vitest-environment jsdom
/**
 * WP2 commit 6e: first-run setup's way through for someone who only uses
 * Codex. When the Claude Code CLI is missing, the "not installed" screen keeps
 * Retry and Back and adds "Use Codex only", which continues without Claude
 * Code and, once App has loaded the config, saves Claude off and Codex on.
 *
 * Verifies:
 *   - the button and its line are on the missing-CLI screen, beside Retry and
 *     Back, and not on the screen of a machine that has the CLI;
 *   - it completes setup with { codexOnly: true }, spawns nothing and writes
 *     nothing itself (the config is not loaded yet at that point);
 *   - it tells the assistants page that follows that Claude Code is missing;
 *   - what App saves for it (both keys), and nothing for a plain completion;
 *   - a start-up with Claude Code off skips the version-change Claude CLI step;
 *   - App's wiring (setup-handoff.ts, run as behaviour): each setup screen
 *     loads (first run), saves the outcome, then stamps; "Use Codex only"
 *     on EITHER screen hands the run to the Codex setup page (a new computer
 *     pointed at an existing resources folder is an upgrader on the first-run
 *     screen); the harness opens for it alone only when nothing else is due;
 *     the start-up Claude CLI step reads the saved setting before the CLI;
 *     App routes through it (the one source check: App cannot be rendered).
 *     What the harness then shows is in onboarding-provider-flow.test.tsx.
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
const pty = { onData: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}), write: vi.fn() }
const configSave = vi.fn(async () => true)
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  setup,
  pty,
  config: { ...((globalThis as any).window.electronAPI?.config ?? {}), save: configSave },
}

vi.mock('@xterm/xterm', () => ({ Terminal: class { cols = 80; rows = 24; loadAddon() {} open() {} write() {} onData() {} dispose() {} } }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

// App's source, through the bundler like any import (no file access here).
const { default: APP_SOURCE } = await import('../../../src/renderer/App.tsx?raw')
const { default: SetupDialog } = await import('../../../src/renderer/components/SetupDialog')
const { claudeWasMissingAtSetup, resetProviderChoiceForTests, skipsClaudeCliSetup } = await import('../../../src/renderer/onboarding/provider-choice')
const { applyFirstRunOutcome } = await import('../../../src/renderer/onboarding/save-provider-choice')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const setupHandoff = await import('../../../src/renderer/onboarding/setup-handoff')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  setup.probeCli.mockReset()
  setup.probeCli.mockResolvedValue({ installed: false, probe: 'where claude' })
  setup.spawnCliSetup.mockClear()
  setup.killCliSetup.mockClear()
  configSave.mockClear()
  resetProviderChoiceForTests()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
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
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  return onComplete
}

describe('first-run setup: Use Codex only', () => {
  it('the missing-CLI screen offers it beside Retry and Back, with its line', async () => {
    await renderAtStep2()
    expect(byTest('setup-cli-missing')).not.toBeNull()
    expect(byTest('setup-cli-retry')).not.toBeNull()
    expect(byTest('setup-cli-back')).not.toBeNull()
    expect(byTest('setup-codex-only-button')!.textContent).toBe('Use Codex only')
    expect(byTest('setup-codex-only')!.textContent).toContain(
      'Only using Codex? Continue without Claude Code; you can add it later in Settings, Accounts.',
    )
  })

  it('is not offered when the CLI is installed', async () => {
    setup.probeCli.mockResolvedValue({ installed: true, path: 'C:\\bin\\claude.cmd', probe: 'where claude.cmd' })
    await renderAtStep2()
    expect(byTest('setup-cli-missing')).toBeNull()
    expect(byTest('setup-codex-only-button')).toBeNull()
  })

  it('completes setup with codexOnly, spawns nothing and writes nothing itself', async () => {
    const onComplete = await renderAtStep2()
    expect(onComplete).not.toHaveBeenCalled()

    await act(async () => { byTest('setup-codex-only-button')!.click() })

    expect(onComplete).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith({ codexOnly: true })
    expect(setup.spawnCliSetup).not.toHaveBeenCalled()
    // Nothing saved before App has loaded the config (a settings file written
    // first would also stop the one-time localStorage migration).
    expect(configSave).not.toHaveBeenCalled()
  })

  it('tells the assistants page that Claude Code is missing', async () => {
    await renderAtStep2()
    expect(claudeWasMissingAtSetup()).toBe(false)
    await act(async () => { byTest('setup-codex-only-button')!.click() })
    expect(claudeWasMissingAtSetup()).toBe(true)
  })

  it('Retry and Back still do what they did', async () => {
    const onComplete = await renderAtStep2()
    await act(async () => { byTest('setup-cli-retry')!.click() })
    await act(async () => { await Promise.resolve() })
    expect(setup.probeCli).toHaveBeenCalledTimes(2)
    await act(async () => { byTest('setup-cli-back')!.click() })
    expect(byTest('setup-cli-missing')).toBeNull()
    expect(onComplete).not.toHaveBeenCalled()
  })
})

describe('what App saves for it', () => {
  it('codexOnly saves Claude off and Codex on: in the store at once, then to disk', async () => {
    const saving = applyFirstRunOutcome({ codexOnly: true })
    const s = useSettingsStore.getState().settings
    expect(s.claudeEnabled).toBe(false)
    expect(s.codexEnabled).toBe(true)
    await saving
    expect(configSave).toHaveBeenCalledTimes(1)
    const [key, data] = configSave.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(key).toBe('settings')
    expect(data.claudeEnabled).toBe(false)
    expect(data.codexEnabled).toBe(true)
  })

  it('a plain completion saves nothing', () => {
    expect(applyFirstRunOutcome(undefined)).toBeUndefined()
    expect(applyFirstRunOutcome({})).toBeUndefined()
    expect(configSave).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().settings.claudeEnabled).toBeUndefined()
  })

  it('a start-up with Claude Code off skips the Claude CLI setup step', () => {
    expect(skipsClaudeCliSetup({ claudeEnabled: false, codexEnabled: true })).toBe(true)
    expect(skipsClaudeCliSetup({})).toBe(false)
    expect(skipsClaudeCliSetup({ claudeEnabled: true })).toBe(false)
  })
})

// App cannot be rendered in a unit test (it boots the whole app), so its
// setup wiring lives in setup-handoff.ts and is run here as behaviour; the
// only source check left is that App routes through it.
describe('App wiring (setup-handoff.ts)', () => {
  const { finishSetup, harnessRun, cliSetupAtStart } = setupHandoff

  function steps(withLoad: boolean) {
    const order: string[] = []
    const s = {
      ...(withLoad ? { loadConfig: vi.fn(async () => { order.push('load') }) } : {}),
      handOffCodexSetup: vi.fn(() => { order.push('hand-off') }),
      stampSetupVersion: vi.fn(() => {
        // What the stamp sees: the choice is already in the store.
        const st = useSettingsStore.getState().settings
        order.push(`stamp claude=${String(st.claudeEnabled)} codex=${String(st.codexEnabled)}`)
      }),
      close: vi.fn(() => { order.push('close') }),
    }
    return { s, order }
  }

  it('first run, "Use Codex only": load the config, save the choice, hand off to Codex setup, stamp, close; in that order', async () => {
    const { s, order } = steps(true)
    await finishSetup({ codexOnly: true }, s)
    expect(order).toEqual(['load', 'hand-off', 'stamp claude=false codex=true', 'close'])
  })

  it('version change, "Use Codex only": the same hand-off (the upgrader never sees the assistants page)', async () => {
    const { s, order } = steps(false)
    await finishSetup({ codexOnly: true }, s)
    expect(order).toEqual(['hand-off', 'stamp claude=false codex=true', 'close'])
  })

  it('a plain completion hands nothing off and saves nothing, on either screen', async () => {
    for (const withLoad of [true, false]) {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
      const { s, order } = steps(withLoad)
      await finishSetup(undefined, s)
      expect(s.handOffCodexSetup).not.toHaveBeenCalled()
      expect(order.at(-2)).toBe('stamp claude=undefined codex=undefined')
    }
  })

  it('the hand-off opens the harness: alone only when nothing else is due, otherwise inside that run', () => {
    expect(harnessRun({ fullFlowDue: false, whatsNewOnly: false, codexSetupHandOff: true })).toEqual({ due: true, codexSetupOnly: true })
    expect(harnessRun({ fullFlowDue: false, whatsNewOnly: true, codexSetupHandOff: true })).toEqual({ due: true, codexSetupOnly: false })
    expect(harnessRun({ fullFlowDue: true, whatsNewOnly: false, codexSetupHandOff: true })).toEqual({ due: true, codexSetupOnly: false })
    expect(harnessRun({ fullFlowDue: false, whatsNewOnly: false, codexSetupHandOff: false })).toEqual({ due: false, codexSetupOnly: false })
    expect(harnessRun({ fullFlowDue: false, whatsNewOnly: true, codexSetupHandOff: false })).toEqual({ due: true, codexSetupOnly: false })
  })

  it('the start-up Claude CLI step: never with Claude Code off (the CLI is not even asked), nor with a config; otherwise as the CLI says', async () => {
    const isCliReady = vi.fn(async () => false)
    expect(await cliSetupAtStart({ hasExistingConfig: false, settings: { claudeEnabled: false, codexEnabled: true }, isCliReady })).toBe('stamp')
    expect(await cliSetupAtStart({ hasExistingConfig: true, settings: {}, isCliReady })).toBe('stamp')
    expect(isCliReady).not.toHaveBeenCalled()
    expect(await cliSetupAtStart({ hasExistingConfig: false, settings: {}, isCliReady })).toBe('ask')
    isCliReady.mockResolvedValueOnce(true)
    expect(await cliSetupAtStart({ hasExistingConfig: false, settings: { claudeEnabled: true }, isCliReady })).toBe('stamp')
  })

  it('App routes both setup screens, the harness gate and the start-up CLI step through it', () => {
    const APP = (APP_SOURCE as string).replace(/\r\n/g, '\n')
    const first = APP.indexOf('return <SetupDialog onComplete={(outcome) => finishSetup(outcome, {')
    const change = APP.indexOf('<SetupDialog initialStep={2} onComplete={(outcome) => finishSetup(outcome, {')
    expect(first).toBeGreaterThan(-1)
    expect(change).toBeGreaterThan(-1)
    const firstHandler = APP.slice(first, APP.indexOf('})} />', first))
    const changeHandler = APP.slice(change, APP.indexOf('})} />', change))
    expect(firstHandler).toContain('loadConfig: loadAndHydrateConfig')
    for (const h of [firstHandler, changeHandler]) expect(h).toContain('handOffCodexSetup: () => setCodexSetupHandOff(true)')
    expect(APP).toContain('const onboardingDue = harness.due')
    expect(APP).toContain('codexSetupOnly={harness.codexSetupOnly}')
    const at = APP.indexOf('codexSetupOnly={harness.codexSetupOnly}')
    expect(APP.slice(at, APP.indexOf('/>', at))).toContain('setCodexSetupHandOff(false)')
    expect(APP).toContain('const cliStep = await cliSetupAtStart({')
  })
})
