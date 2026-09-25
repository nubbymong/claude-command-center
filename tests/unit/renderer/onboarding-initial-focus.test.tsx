// @vitest-environment jsdom
/**
 * Each page's primary button has focus when the page opens (VM audit
 * 2026-09-25, item 2: focus was left on the page body on first-run setup,
 * Welcome, the assistants page and Set up Codex; Hello Codex already did it).
 *
 * Verifies:
 *   - first-run setup: Continue on the folders screen, Retry on the "Claude
 *     Code is not installed" screen, and Continue again after Back (each
 *     screen is mounted afresh);
 *   - Welcome: "Let's go"; the assistants page: Continue;
 *   - Set up Codex, per state: the first install command's button (Check
 *     again when none can take focus), the first sign-in method, the
 *     Recommended new account, Next once signed in, Skip for now with no
 *     account list; again when the state moves on and the control that had
 *     focus went with it (a sign-in landing); never taken from a control the
 *     user is on.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot, InstallRecipeView, ProviderInstallationView } from '../../../src/shared/providers'
import { codexInstallRecipes } from '../../../src/main/providers/codex/install-recipes'
import { recipeRunLine } from '../../../src/main/providers/core/recipe-run-line'
import { provider, account, snapshot, claudeMain } from './accounts-snapshot-harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const RECIPES: InstallRecipeView[] = codexInstallRecipes('win32').map((r) => {
  const runLine = recipeRunLine(r, 'win32')
  return {
    id: r.id, providerId: r.providerId, purpose: r.purpose, publisher: r.publisher, sourceUrl: r.sourceUrl, displayCommand: r.displayCommand,
    method: r.method, needsNetwork: r.needsNetwork, mayElevate: r.mayElevate, autoRunAllowed: r.autoRunAllowed, ...(r.note !== undefined ? { note: r.note } : {}),
    ...(runLine !== undefined ? { runLine } : {}),
  }
})

const ok = () => Promise.resolve({ ok: true })
const pa = {
  snapshot: vi.fn(async () => null),
  onChanged: vi.fn(() => () => {}),
  discover: vi.fn(),
  installRecipes: vi.fn(async () => RECIPES),
  runMigration: vi.fn(async () => ({ ok: true, outcome: 'not-signed-in' })),
  setEnabled: vi.fn(ok),
  adoptExternal: vi.fn(async () => ({ ok: true, accountId: 'acc-ext' })),
}
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
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  providerAccounts: pa,
  setup,
  pty: { onData: vi.fn(() => () => {}), onExit: vi.fn(() => () => {}), write: vi.fn() },
  config: { ...((globalThis as any).window.electronAPI?.config ?? {}), save: vi.fn(async () => true) },
}
vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn() }))
// A terminal that, like xterm, keeps its keyboard input in a textarea it puts
// in the container it is opened in, and focuses that textarea on focus().
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    input: HTMLTextAreaElement | null = null
    loadAddon() {}
    open(el: HTMLElement) {
      this.input = document.createElement('textarea')
      this.input.setAttribute('data-testid', 'xterm-input')
      el.appendChild(this.input)
    }
    focus() { this.input?.focus() }
    write() {}
    writeln() {}
    onData() {}
    dispose() { this.input?.remove() }
  },
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }))

const { WelcomeStep } = await import('../../../src/renderer/onboarding/WelcomeStep')
const { AssistantsStep } = await import('../../../src/renderer/onboarding/AssistantsStep')
const { CodexSetupStep } = await import('../../../src/renderer/onboarding/CodexSetupStep')
const { default: SetupDialog } = await import('../../../src/renderer/components/SetupDialog')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { resetProviderChoiceForTests } = await import('../../../src/renderer/onboarding/provider-choice')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  pa.discover.mockReset()
  pa.discover.mockImplementation(async () => ({ ok: true, installation: useProviderAccountsStore.getState().snapshot!.providers[1] }))
  pa.installRecipes.mockClear()
  pa.installRecipes.mockResolvedValue(RECIPES)
  setup.probeCli.mockReset()
  setup.probeCli.mockResolvedValue({ installed: false, probe: 'where claude' })
  resetProviderChoiceForTests()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} }
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
})

const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const focused = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null

/** A focused button that becomes disabled loses the focus in the browser
 *  (it falls to the page body). jsdom keeps it there, and ignores blur() on a
 *  disabled element, so the drop is made the way jsdom does honour: focus
 *  moves to an element that is then removed. */
function dropFocusToBody() {
  const tmp = document.createElement('input')
  document.body.appendChild(tmp)
  tmp.focus()
  tmp.remove()
  expect(document.activeElement).toBe(document.body)
}

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
}

async function render(el: React.ReactElement) {
  await act(async () => { root.render(el) })
  await flush()
}

describe('first-run setup', () => {
  it('the folders screen opens on Continue', async () => {
    await render(<SetupDialog onComplete={vi.fn()} />)
    expect(byTest('setup-continue')).not.toBeNull()
    expect(focused()).toBe('setup-continue')
  })

  it('the "Claude Code is not installed" screen opens on Retry, and Back opens the folders screen on Continue again', async () => {
    await render(<SetupDialog onComplete={vi.fn()} />)
    await act(async () => { byTest('setup-continue')!.click() })
    await flush()
    expect(byTest('setup-cli-missing')).not.toBeNull()
    expect(focused()).toBe('setup-cli-retry')
    // A real click focuses what it clicks (jsdom's click() does not): Back
    // has focus when it goes, as it does for a user.
    byTest('setup-cli-back')!.focus()
    await act(async () => { byTest('setup-cli-back')!.click() })
    await flush()
    expect(focused()).toBe('setup-continue')
  })

  it('Retry has the focus again when its check comes back still "not installed"', async () => {
    await render(<SetupDialog onComplete={vi.fn()} initialStep={2} />)
    expect(focused()).toBe('setup-cli-retry')
    let answer!: (v: unknown) => void
    setup.probeCli.mockImplementation(() => new Promise((r) => { answer = r }))
    await act(async () => { byTest('setup-cli-retry')!.click() })
    // Disabled while it checks: the browser drops the focus it had.
    expect((byTest('setup-cli-retry') as HTMLButtonElement).disabled).toBe(true)
    dropFocusToBody()
    await act(async () => { answer({ installed: false, probe: 'where claude' }) })
    await flush()
    expect(byTest('setup-cli-missing')).not.toBeNull()
    expect(focused()).toBe('setup-cli-retry')
  })

  it('the Claude CLI Setup screen gives the terminal the focus once it opens', async () => {
    setup.probeCli.mockResolvedValue({ installed: true, path: 'C:\\bin\\claude.cmd', probe: 'where claude.cmd' })
    // The terminal opens once its container has a size, on an animation frame.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 })
    const raf = window.requestAnimationFrame
    ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => { cb(0); return 1 }
    try {
      await render(<SetupDialog onComplete={vi.fn()} initialStep={2} />)
      expect(byTest('xterm-input')).not.toBeNull()
      expect(focused()).toBe('xterm-input')
    } finally {
      delete (HTMLElement.prototype as any).clientWidth
      delete (HTMLElement.prototype as any).clientHeight
      ;(window as any).requestAnimationFrame = raf
    }
  })
})

describe('Welcome and the assistants page', () => {
  it('Welcome opens on "Let\'s go"', async () => {
    await render(<WelcomeStep onNext={vi.fn()} />)
    expect(focused()).toBe('welcome-next')
  })

  it('the assistants page opens on Continue', async () => {
    await render(<AssistantsStep onNext={vi.fn()} onBack={vi.fn()} />)
    expect(focused()).toBe('assistants-continue')
  })

  it('Continue has the focus again when saving the choice fails', async () => {
    const onNext = vi.fn()
    await render(<AssistantsStep onNext={onNext} onBack={vi.fn()} />)
    let answer!: (v: unknown) => void
    pa.setEnabled.mockImplementationOnce(() => new Promise((r) => { answer = r }) as never)
    await act(async () => { byTest('assistants-continue')!.click() })
    // Disabled while it saves: the browser drops the focus it had.
    expect((byTest('assistants-continue') as HTMLButtonElement).disabled).toBe(true)
    dropFocusToBody()
    await act(async () => { answer({ ok: false, code: 'consumers', consumers: 2, message: 'in use' }) })
    await flush()
    expect(onNext).not.toHaveBeenCalled()
    expect(byTest('assistants-error')).not.toBeNull()
    expect(focused()).toBe('assistants-continue')
  })
})

describe('Set up Codex: focus follows the page\'s primary control', () => {
  function codex(over: Partial<ProviderInstallationView> = {}): ProviderInstallationView {
    return provider({ providerId: 'codex', displayName: 'Codex', lastCheckedAt: 1, ...over })
  }
  function snap(codexOver: Partial<ProviderInstallationView>, over: Partial<AccountsSnapshot> = {}): AccountsSnapshot {
    return snapshot({
      providers: [provider({ providerId: 'claude', displayName: 'Claude Code', version: '2.1.281' }), codex(codexOver)],
      accounts: [claudeMain],
      ...over,
    })
  }
  // What main recorded about this computer's own sign-in, as main does after
  // the assistants choice (the fixtures onboarding-codex-setup.test.tsx uses).
  const marked = (marker: Record<string, unknown>) => ({ externalDefaults: [{ providerId: 'codex' as const, needsConfirmation: false, marker: { at: 1, ...marker } as any }] })
  const notFoundHere = marked({ outcome: 'none' })
  const setupPage = () => <CodexSetupStep onNext={vi.fn()} onBack={vi.fn()} stepAside={vi.fn()} returns={0} />

  async function show(s: AccountsSnapshot | null) {
    useProviderAccountsStore.setState({ snapshot: s, loaded: true })
    await render(setupPage())
  }

  it('CLI not found: the first install command\'s button', async () => {
    await show(snap({ discoveryState: 'missing', version: undefined }))
    expect(focused()).toBe('codex-recipe-run-codex-npm-install')
  })

  it('CLI not found, and no command can take focus: Check again', async () => {
    pa.installRecipes.mockResolvedValue([])
    await show(snap({ discoveryState: 'missing', version: undefined }))
    expect(focused()).toBe('codex-setup-check-again')
  })

  it('too old: the update command\'s button', async () => {
    await show(snap({ discoveryState: 'found', version: '0.100.0', compatibility: 'too-old' }))
    expect(focused()).toBe('codex-recipe-run-codex-npm-update')
  })

  it('ready to sign in: the first sign-in method', async () => {
    await show(snap({}, notFoundHere))
    const first = document.querySelector('[data-testid^="codex-setup-method-"]')!.getAttribute('data-testid')
    expect(focused()).toBe(first)
  })

  it('this computer\'s sign-in found: the Recommended new account', async () => {
    await show(snap({}, marked({ outcome: 'registered' })))
    expect(byTest('codex-setup-adopt')).not.toBeNull()
    expect(focused()).toBe('codex-setup-add-new')
  })

  it('signed in: Next', async () => {
    const signed = account({ id: 'acc-codex', providerId: 'codex', identityId: 'id-work', isProviderDefault: true })
    await show(snap({}, { accounts: [claudeMain, signed] }))
    expect(focused()).toBe('codex-setup-next')
  })

  it('no account list: Skip for now', async () => {
    pa.discover.mockImplementation(async () => ({ ok: false, code: 'registry-unavailable', message: 'x' }))
    await show(null)
    expect(byTest('codex-setup-unavailable')).not.toBeNull()
    expect(focused()).toBe('codex-setup-skip')
  })

  it('a sign-in landing: the method that had focus goes, and focus goes to Next, not the page body', async () => {
    await show(snap({}, notFoundHere))
    expect(focused()).toMatch(/^codex-setup-method-/)
    const signed = account({ id: 'acc-codex', providerId: 'codex', identityId: 'id-work', isProviderDefault: true })
    await act(async () => { useProviderAccountsStore.setState({ snapshot: snap({}, { ...notFoundHere, accounts: [claudeMain, signed] }) }) })
    await flush()
    expect(byTest('codex-setup-done')).not.toBeNull()
    expect(focused()).toBe('codex-setup-next')
  })

  it('never takes focus from a control the user is on', async () => {
    // Discovery still out: nothing to focus yet, and the user moves to Back.
    let answer!: (v: unknown) => void
    pa.discover.mockImplementation(() => new Promise((r) => { answer = r }))
    await show(snap({ discoveryState: 'unchecked', version: undefined }))
    expect(focused()).toBe('BODY')
    byTest('codex-setup-back')!.focus()
    await act(async () => { answer({ ok: true, installation: codex({ discoveryState: 'missing', version: undefined, lastCheckedAt: 2 }) }) })
    await flush()
    expect(byTest('codex-setup-missing')).not.toBeNull()
    expect(focused()).toBe('codex-setup-back')
  })
})
