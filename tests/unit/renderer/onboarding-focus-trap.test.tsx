// @vitest-environment jsdom
/**
 * The window-covering surfaces keep keyboard focus (VM audit 2026-09-25,
 * item 1): Tab and Shift+Tab used to walk out of the onboarding pages and
 * Hello Codex (takeover and replay) into the hidden title bar and sidebar.
 *
 * Verifies:
 *   - the onboarding shell keeps Tab inside it: round from the last control
 *     to the first, Shift+Tab round from the first to the last, and a Tab
 *     with focus outside (the page body) comes back in; tabindex -1 and
 *     disabled controls are not stops; nothing is trapped while the shell is
 *     stepped aside (hidden) for a terminal;
 *   - it gives way to a dialog open above it (its keys are that dialog's);
 *   - the Hello Codex takeover and a replay keep Tab in, and the close dialog
 *     above the takeover keeps its own Tab, Escape and arrows (6f A1);
 *   - the harness tells App when it steps aside and comes back, and App
 *     makes the app behind inert on exactly the covering surfaces
 *     (appCovered), with the close dialogs outside the inert part.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__APP_VERSION__ = '2.1.1-beta.1'

vi.mock('../../../src/renderer/onboarding/WhatsNewV2Step', async () => ({ WhatsNewV2Step: (await import('./onboarding-flow-stubs')).WhatsNewStub }))
vi.mock('../../../src/renderer/onboarding/WelcomeStep', async () => ({ WelcomeStep: (await import('./onboarding-flow-stubs')).stub('welcome') }))
vi.mock('../../../src/renderer/onboarding/CommandBarStep', async () => ({ CommandBarStep: (await import('./onboarding-flow-stubs')).stub('commandBar') }))
vi.mock('../../../src/renderer/onboarding/FindClaudeStep', async () => ({ FindClaudeStep: (await import('./onboarding-flow-stubs')).stub('findClaude') }))
vi.mock('../../../src/renderer/onboarding/CompatibilityStep', async () => ({ CompatibilityStep: (await import('./onboarding-flow-stubs')).stub('compatibility') }))
vi.mock('../../../src/renderer/onboarding/AccountsStep', async () => ({ AccountsStep: (await import('./onboarding-flow-stubs')).stub('accounts') }))
vi.mock('../../../src/renderer/onboarding/GitHubStep', async () => ({ GitHubStep: (await import('./onboarding-flow-stubs')).stub('github') }))
vi.mock('../../../src/renderer/onboarding/StatusLineStep', async () => ({ StatusLineStep: (await import('./onboarding-flow-stubs')).stub('statusline') }))
vi.mock('../../../src/renderer/onboarding/BuiltinToolsStep', async () => ({ BuiltinToolsStep: (await import('./onboarding-flow-stubs')).stub('builtinTools') }))
vi.mock('../../../src/renderer/onboarding/TransparencyStep', async () => ({ TransparencyStep: (await import('./onboarding-flow-stubs')).stub('transparency') }))
vi.mock('../../../src/renderer/onboarding/FinishStep', async () => ({ FinishStep: (await import('./onboarding-flow-stubs')).FinishStub }))
vi.mock('../../../src/renderer/onboarding/CodexSetupStep', async () => ({ CodexSetupStep: (await import('./onboarding-flow-stubs')).CodexSetupStub }))
vi.mock('../../../src/renderer/onboarding/settle', () => ({ settleOnboardingFinish: vi.fn(), settleWhatsNewOnly: vi.fn() }))
vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: vi.fn(() => Promise.resolve(true)),
  saveConfigDebounced: vi.fn(),
  flushPendingConfigSaves: vi.fn(() => Promise.resolve()),
  retryFailedConfigSaves: vi.fn(() => Promise.resolve()),
}))

const ok = () => Promise.resolve({ ok: true })
;(globalThis as any).window.electronAPI = {
  ...(globalThis as any).window.electronAPI,
  providerAccounts: { setEnabled: vi.fn(ok), discover: vi.fn(ok) },
}
;(globalThis as any).window.electronPlatform = 'win32'

const h = React.createElement
const { OnboardingShell } = await import('../../../src/renderer/onboarding/OnboardingShell')
const { OnboardingHarness } = await import('../../../src/renderer/onboarding/OnboardingHarness')
const { HelloCodexTakeover, helloCodexShowing } = await import('../../../src/renderer/onboarding/HelloCodex')
const { useHelloCodexStore } = await import('../../../src/renderer/onboarding/hello-codex')
const { tabStops } = await import('../../../src/renderer/onboarding/contain-focus')
const { default: CloseDialog } = await import('../../../src/renderer/components/CloseDialog')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useAppMetaStore } = await import('../../../src/renderer/stores/appMetaStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { usePaneOcclusionStore } = await import('../../../src/renderer/stores/paneOcclusionStore')
const { resetProviderChoiceForTests } = await import('../../../src/renderer/onboarding/provider-choice')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  ;(window as any).matchMedia = (q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  })
  resetProviderChoiceForTests()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
  useAppMetaStore.setState({ meta: {} })
  useProviderAccountsStore.setState({ snapshot: null, loaded: true })
  useHelloCodexStore.setState({ open: null })
  usePaneOcclusionStore.setState({ overlays: 0 })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
})

const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const active = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null

/** Press Tab (or Shift+Tab) where focus is, as the browser delivers it: a
 *  keydown on the focused element that bubbles to window. jsdom moves no
 *  focus itself, so what moves it here is the trap, and only the trap.
 *  Returns whether the key was taken (default prevented). */
async function tab(shift = false): Promise<boolean> {
  const target = (document.activeElement as HTMLElement | null) ?? document.body
  const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true })
  await act(async () => { target.dispatchEvent(ev) })
  return ev.defaultPrevented
}

async function render(el: React.ReactElement) {
  await act(async () => { root.render(el) })
}

/** The app around a covering surface: a title-bar button before it (where
 *  Tab used to escape to) and a sidebar button after it. */
function Around({ children }: { children: React.ReactNode }) {
  return h(React.Fragment, null,
    h('button', { type: 'button', 'data-testid': 'titlebar-btn' }, 'Services'),
    children,
    h('button', { type: 'button', 'data-testid': 'sidebar-btn' }, 'Insights'))
}

function Page({ hidden = false }: { hidden?: boolean }) {
  return h(Around, null,
    h(OnboardingShell, { phase: 0, hidden },
      h('button', { type: 'button', 'data-testid': 'p-back' }, 'Back'),
      h('button', { type: 'button', 'data-testid': 'p-skipped', tabIndex: -1 }, 'Not a stop'),
      h('button', { type: 'button', 'data-testid': 'p-next' }, 'Next'),
      h('button', { type: 'button', 'data-testid': 'p-off', disabled: true }, 'Disabled')))
}

describe('the onboarding shell keeps Tab on its pages', () => {
  it('Tab from the last control goes round to the first, not out to the title bar or sidebar', async () => {
    await render(h(Page))
    byTest('p-next')!.focus()
    expect(await tab()).toBe(true)
    expect(active()).toBe('p-back')
  })

  it('Shift+Tab from the first control goes round to the last', async () => {
    await render(h(Page))
    byTest('p-back')!.focus()
    expect(await tab(true)).toBe(true)
    expect(active()).toBe('p-next')
  })

  it('a Tab between two of its controls is the browser\'s own move (not taken)', async () => {
    await render(h(Page))
    byTest('p-back')!.focus()
    expect(await tab()).toBe(false)
  })

  it('with focus on the page body, Tab comes back in to the first control and Shift+Tab to the last', async () => {
    await render(h(Page))
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(document.activeElement).toBe(document.body)
    expect(await tab()).toBe(true)
    expect(active()).toBe('p-back')
    ;(document.activeElement as HTMLElement | null)?.blur()
    expect(await tab(true)).toBe(true)
    expect(active()).toBe('p-next')
  })

  it('with focus in the app behind, Tab is pulled back onto the page', async () => {
    await render(h(Page))
    byTest('titlebar-btn')!.focus()
    expect(await tab()).toBe(true)
    expect(active()).toBe('p-back')
  })

  it('tabindex -1 and disabled controls are not stops', async () => {
    await render(h(Page))
    const shell = document.querySelector('.ob-root')!
    expect(tabStops(shell).map((el) => el.getAttribute('data-testid'))).toEqual(['p-back', 'p-next'])
  })

  it('stepped aside (hidden) for a terminal, nothing is trapped', async () => {
    await render(h(Page, { hidden: true }))
    byTest('titlebar-btn')!.focus()
    expect(await tab()).toBe(false)
    expect(active()).toBe('titlebar-btn')
  })

  it('nor while the shell is not on screen at all (inside something hidden)', async () => {
    await render(h(React.Fragment, null,
      h('button', { type: 'button', 'data-testid': 'outside-btn' }, 'Outside'),
      h('div', { style: { display: 'none' } }, h(OnboardingShell, { phase: 0 }, h('button', { type: 'button' }, 'Next')))))
    byTest('outside-btn')!.focus()
    expect(await tab()).toBe(false)
    expect(active()).toBe('outside-btn')
  })

  it('gives way to a dialog open above it: that dialog keeps its own Tab', async () => {
    await render(h(React.Fragment, null,
      h(Page),
      h('div', { 'data-dialog-overlay': '', 'data-testid': 'above' },
        h('button', { type: 'button', 'data-testid': 'above-last' }, 'Cancel'))))
    byTest('above-last')!.focus()
    expect(await tab()).toBe(false)
    expect(active()).toBe('above-last')
  })
})

describe('Hello Codex, the takeover and a replay, keep Tab in', () => {
  it('replay: Tab from the primary button (the last control) goes to the first page dot, not the title bar', async () => {
    await render(h(Around, null, h(HelloCodexTakeover, { replay: true, onClose: vi.fn(), onStartSession: vi.fn() })))
    expect(active()).toBe('hc-primary')
    expect(await tab()).toBe(true)
    expect(active()).toBe('hc-dot-1')
    expect(await tab(true)).toBe(true)
    expect(active()).toBe('hc-primary')
  })

  it('takeover: the same, once it has armed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await render(h(Around, null, h(HelloCodexTakeover, { onClose: vi.fn(), onStartSession: vi.fn() })))
      await act(async () => { vi.advanceTimersByTime(1000) })
    } finally {
      vi.useRealTimers()
    }
    byTest('hc-primary')!.focus()
    expect(await tab()).toBe(true)
    expect(active()).toBe('hc-dot-1')
  })

  it('6f A1: with the close dialog open above the takeover, Tab, Escape and the arrows stay the dialog\'s', async () => {
    const onClose = vi.fn()
    const onCancel = vi.fn()
    await render(h(React.Fragment, null,
      h(HelloCodexTakeover, { replay: true, onClose, onStartSession: vi.fn() }),
      h(CloseDialog, { mode: 'close', sessionCount: 2, onSaveAndClose: vi.fn(), onCloseWithoutSaving: vi.fn(), onCancel })))
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]:not([data-testid="hello-codex"])') as HTMLElement
    const buttons = Array.from(dialog.querySelectorAll('button'))
    buttons[buttons.length - 1].focus()
    const before = document.activeElement
    await tab()
    // The takeover did not pull focus back onto itself.
    expect(byTest('hello-codex')!.contains(document.activeElement)).toBe(false)
    expect(dialog.contains(document.activeElement) || document.activeElement === before).toBe(true)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
    expect(byTest('hc-heading')!.textContent).toBe('Hello, Codex')
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('the app behind is inert while a covering surface shows', () => {
  it('helloCodexShowing is the host\'s render rule: a replay always, the takeover on its turn', () => {
    expect(helloCodexShowing('replay', false)).toBe(true)
    expect(helloCodexShowing('replay', true)).toBe(true)
    expect(helloCodexShowing('takeover', true)).toBe(true)
    expect(helloCodexShowing('takeover', false)).toBe(false)
    expect(helloCodexShowing(null, true)).toBe(false)
  })

  it('the harness tells App when it steps aside for a terminal and when it comes back', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, codexEnabled: true, claudeEnabled: false }, isLoaded: true })
    const onAsideChange = vi.fn()
    await render(h(OnboardingHarness, { onComplete: vi.fn(), codexSetupOnly: true, onAsideChange }))
    expect(byTest('page')!.getAttribute('data-page')).toBe('codexSetup')
    expect(onAsideChange).toHaveBeenLastCalledWith(false)
    await act(async () => { byTest('stub-step-aside')!.click() })
    expect(onAsideChange).toHaveBeenLastCalledWith(true)
    // Stepped aside, the pages keep nothing in: the terminal is the user's.
    expect((document.querySelector('.ob-root') as HTMLElement).style.display).toBe('none')
    await act(async () => { byTest('onboarding-back-to-setup-button')!.click() })
    expect(onAsideChange).toHaveBeenLastCalledWith(false)
    await act(async () => { byTest('stub-step-aside')!.click() })
    expect(onAsideChange).toHaveBeenLastCalledWith(true)
    // Gone while aside: App is told it is not aside any more.
    act(() => { root.unmount() })
    root = createRoot(container)
    expect(onAsideChange).toHaveBeenLastCalledWith(false)
  })

  describe('App wiring (source: App is too large to render here)', () => {
    const APP = readFileSync(resolve(__dirname, '../../../src/renderer/App.tsx'), 'utf8').replace(/\r\n/g, '\n')

    it('appCovered is the onboarding pages (unless aside) or Hello Codex on screen', () => {
      expect(APP).toContain("const appCovered = (bootGate === 'onboarding' && !onboardingAside) || helloCodexShowing(helloCodexOpen, boot.helloCodexTurn)")
      expect(APP).toContain('onAsideChange={setOnboardingAside}')
      expect(APP).toContain('const helloCodexOpen = useHelloCodexStore((s) => s.open)')
    })

    it('the title bar, sidebar, sessions and bottom bar sit in one inert wrapper; the close dialogs do not', () => {
      const open = APP.indexOf('<div className="contents" inert={appCovered} data-testid="app-behind">')
      expect(open, 'the inert wrapper').toBeGreaterThan(0)
      const title = APP.indexOf('<TitleBar ', open)
      const bottom = APP.indexOf('<BottomBar ', open)
      expect(title).toBeGreaterThan(open)
      expect(bottom).toBeGreaterThan(title)
      // Only TitleBar comes between the wrapper's opening and the title bar.
      expect(APP.slice(open, title).match(/</g)!.length).toBe(1)
      // The wrapper closes right after the bottom bar's own wrapper.
      const after = APP.slice(bottom).split('\n').slice(1, 4).map((l) => l.trim())
      expect(after).toEqual(['</div>', '</div>', "{bootGate === 'training' && ("])
      for (const dialog of ['<SshCloseDialog />', '<CloseDialog', '<HelloCodexHost', '<OnboardingHarness']) {
        expect(APP.indexOf(dialog), `${dialog} is outside the inert part`).toBeLessThan(open)
      }
      expect(APP.match(/inert=\{/g)!.length, 'one inert site').toBe(1)
    })
  })
})
