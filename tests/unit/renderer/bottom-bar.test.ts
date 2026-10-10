// @vitest-environment jsdom
/**
 * UAT R2: BottomBar is now a slim GLOBAL runtime footer -- one left-aligned
 * band: CLI status dot + "CLI" + version + Beta pill + Update pill. The
 * per-session telemetry and the Mode/Model/Compact/Restart controls moved up
 * into SessionStatusStrip (covered by session-status-strip.test.ts). The big
 * green sidebar Update toast was removed; the footer Update pill is the single
 * update affordance and pulses (via the .footer-update-pulse class) when an
 * update is available.
 *
 * Uses React.createElement (not JSX) so the file stays a *.test.ts under the
 * vitest include glob.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// __APP_VERSION__/__BUILD_TIME__ are esbuild `define` globals at build time.
;(globalThis as any).__APP_VERSION__ = '9.9.9-test'
;(globalThis as any).__BUILD_TIME__ = '2026-05-25T00:00:00.000Z'

// --- settings store: selector form + getState, beta channel ---
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const STATE = {
    settings: { updateChannel: 'beta' as const, theme: 'dark' as const },
  }
  const useSettingsStore: any = (selector: (s: typeof STATE) => unknown) => selector(STATE)
  useSettingsStore.getState = () => STATE
  return { useSettingsStore }
})

// --- electronAPI surface the footer touches ---
let updateAvailableResolved = false
const updateInstall = vi.fn()
;(globalThis as any).window.electronAPI = {
  cli: { check: () => Promise.resolve(true) },
  update: {
    check: () => Promise.resolve(updateAvailableResolved),
    onAvailable: () => () => {},
    installAndRestart: updateInstall,
  },
}

const { default: BottomBar } = await import('../../../src/renderer/components/BottomBar')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  updateInstall.mockReset()
  updateAvailableResolved = false
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

async function render(over: { onUpdateRequested?: () => void } = {}): Promise<void> {
  await act(async () => {
    root.render(React.createElement(BottomBar, { currentView: 'sessions', onViewChange: vi.fn(), ...over }))
    // Flush the cli.check()/update.check() promises that resolve after the
    // initial paint, so their setState lands inside an act() boundary.
    await Promise.resolve()
    await Promise.resolve()
  })
}

function buttonByTitle(title: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.getAttribute('title') === title,
  )
}
function buttonByText(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => (b.textContent ?? '').includes(text),
  )
}

describe('BottomBar -- slim runtime footer', () => {
  it('renders version + CLI affordance + a status dot', async () => {
    await render()
    expect(container.textContent).toContain('9.9.9-test')
    expect(container.textContent).toContain('CLI')
    expect(container.querySelector('.rounded-full')).toBeTruthy()
  })

  it('shows the Beta chip on the beta channel', async () => {
    await render()
    expect(buttonByText('Beta')).toBeTruthy()
  })

  it('does NOT render any session controls (they moved to SessionStatusStrip)', async () => {
    await render()
    expect(buttonByTitle('Permission mode')).toBeUndefined()
    expect(buttonByTitle('Model')).toBeUndefined()
    expect(buttonByTitle('Compact the conversation')).toBeUndefined()
    expect(buttonByTitle('Restart session')).toBeUndefined()
  })

  it('does NOT render the Update pill when no update is available', async () => {
    updateAvailableResolved = false
    await render()
    expect(buttonByText('Update')).toBeUndefined()
  })

  it('renders a pulsing Update pill when an update is available', async () => {
    updateAvailableResolved = true
    await render()
    const pill = buttonByText('Update')
    expect(pill).toBeTruthy()
    // Pulse driven by the footer-update-pulse class (CSS handles reduced-motion).
    expect(pill!.classList.contains('footer-update-pulse')).toBe(true)
  })

  it('Update pill defers to onUpdateRequested when provided (graceful close path)', async () => {
    updateAvailableResolved = true
    const onUpdateRequested = vi.fn()
    await render({ onUpdateRequested })
    act(() => { buttonByText('Update')!.click() })
    expect(onUpdateRequested).toHaveBeenCalledTimes(1)
    expect(updateInstall).not.toHaveBeenCalled()
  })

  it('Update pill installs directly when no onUpdateRequested handler is given', async () => {
    updateAvailableResolved = true
    await render()
    act(() => { buttonByText('Update')!.click() })
    expect(updateInstall).toHaveBeenCalledTimes(1)
  })

  it('carries no "not affiliated with Anthropic" line (#383)', async () => {
    // Owner call 2026-08-22: now that the app is AI Code Conductor the
    // footer disclaimer is not wanted anywhere. Checked on the rendered text
    // AND on every title attribute, so it cannot survive as a tooltip either.
    await render()
    expect(container.textContent).not.toMatch(/affiliated|endorsed by/i)
    for (const el of Array.from(container.querySelectorAll<HTMLElement>('[title]'))) {
      expect(el.getAttribute('title')).not.toMatch(/affiliated|endorsed by/i)
    }
  })
})

// WP2 commit 6e review fix: with Claude Code switched off in Settings,
// Accounts there is no Claude CLI to watch. The bar treats it as it treats any
// feature not in use: absent, never a red "not found" every 30 s.
describe('BottomBar with Claude Code switched off', () => {
  it('shows no Claude CLI indicator and never asks for the CLI; with Claude Code on it does', async () => {
    const cliCheck = vi.fn(() => Promise.resolve(false))
    const api = (globalThis as any).window.electronAPI
    const before = api.cli
    api.cli = { check: cliCheck }
    const { useSettingsStore } = await import('../../../src/renderer/stores/settingsStore')
    const st = (useSettingsStore as any).getState()
    st.settings.claudeEnabled = false
    try {
      await render()
      expect(container.querySelector('[data-testid="bottom-bar-cli"]')).toBeNull()
      expect(cliCheck).not.toHaveBeenCalled()
      st.settings.claudeEnabled = undefined
      act(() => { root.unmount() })
      root = createRoot(container)
      await render()
      expect(cliCheck).toHaveBeenCalled()
      expect(container.querySelector('[data-testid="bottom-bar-cli"]')!.getAttribute('title')).toBe('Claude CLI not found -- click for help')
    } finally {
      st.settings.claudeEnabled = undefined
      api.cli = before
    }
  })
})

// PowerShell runs npm.ps1 for a bare `npm`, and its default script policy
// refuses to load it; npm.cmd is not subject to that policy.
describe('BottomBar: the Claude CLI help', () => {
  it('on Windows its npm option names npm.cmd; on macOS and Linux it names npm', async () => {
    const api = (globalThis as any).window.electronAPI
    const before = api.cli
    api.cli = { check: vi.fn(() => Promise.resolve(false)) }
    const w = window as unknown as { electronPlatform?: string }
    const platformBefore = w.electronPlatform
    try {
      for (const [platform, command] of [
        ['win32', 'npm.cmd install -g @anthropic-ai/claude-code'],
        ['darwin', 'npm install -g @anthropic-ai/claude-code'],
        ['linux', 'npm install -g @anthropic-ai/claude-code'],
      ] as const) {
        w.electronPlatform = platform
        await render()
        await act(async () => { (container.querySelector('[data-testid="bottom-bar-cli"]') as HTMLElement).click() })
        expect(document.querySelector('[data-testid="bottombar-cli-npm-install-command"]')?.textContent, platform).toBe(command)
        act(() => { root.unmount() })
        root = createRoot(container)
      }
    } finally {
      w.electronPlatform = platformBefore
      api.cli = before
    }
  })
})

// Owner decisions D2 and D4 (2026-10-10; ADR-024): the CLI help lists main's
// own Claude Code install commands, Anthropic's native installer first, each
// with Run it for me and Copy. `claude install` is gone from it: it needs a
// Claude Code already installed. Run it for me asks first, opens a visible
// install tab and shows it; when that tab ends, and on Check again, the app
// asks main to check again (which brings PATH up to date first) and then reads
// the CLI. Still missing after the tab ended, the help opens again by itself.
// When main says Claude Code is in Anthropic's own folder, off PATH, the help
// says so and offers Add it to PATH for me (the PATH finding of the first-run
// test, 2026-10-10).
const { claudeInstallRecipes } = await import('../../../src/main/providers/claude/install-recipes')
const { installRecipeView } = await import('../../../src/main/providers/core/recipe-run-line')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { GO_TO_SESSION_EVENT } = await import('../../../src/renderer/lib/goToSession')

describe('BottomBar: installing Claude Code from the CLI help', () => {
  const RECIPES = claudeInstallRecipes('win32').map((r) => installRecipeView(r, 'win32'))
  const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
  const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() }) }

  async function openHelp(cliCheck: ReturnType<typeof vi.fn>, providerAccounts: Record<string, unknown>) {
    const api = (globalThis as any).window.electronAPI
    api.cli = { check: cliCheck }
    api.providerAccounts = providerAccounts
    useSessionStore.setState({ sessions: [], activeSessionId: null })
    await render()
    await act(async () => { (container.querySelector('[data-testid="bottom-bar-cli"]') as HTMLElement).click() })
    await flush()
  }

  it("lists main's commands, the native installer first, each with Run it for me and Copy; no claude install", async () => {
    const api = (globalThis as any).window.electronAPI
    const before = { cli: api.cli, pa: api.providerAccounts }
    try {
      const installRecipes = vi.fn(async () => RECIPES)
      await openHelp(vi.fn(() => Promise.resolve(false)), { installRecipes, discover: vi.fn() })
      expect(installRecipes).toHaveBeenCalledWith('claude')
      const shown = [...document.querySelectorAll('[data-testid^="bottombar-recipe-command-"]')].map((c) => c.textContent)
      expect(shown).toEqual(['irm https://claude.ai/install.ps1 | iex', 'npm.cmd install -g @anthropic-ai/claude-code'])
      for (const r of RECIPES) {
        expect(byTest(`bottombar-recipe-run-${r.id}`)!.textContent).toBe('Run it for me')
        expect(byTest(`bottombar-recipe-copy-${r.id}`)!.textContent).toBe('Copy')
      }
      expect(document.body.textContent).not.toContain('claude install')
    } finally {
      api.cli = before.cli
      api.providerAccounts = before.pa
    }
  })

  it('Run it for me asks first, naming claude.ai; Run it opens the install tab and shows it; when the tab ends the app checks again', async () => {
    const api = (globalThis as any).window.electronAPI
    const before = { cli: api.cli, pa: api.providerAccounts }
    const shownTabs: string[] = []
    const onGoTo = (e: Event) => { shownTabs.push((e as CustomEvent).detail.sessionId) }
    window.addEventListener(GO_TO_SESSION_EVENT, onGoTo)
    try {
      const calls: string[] = []
      const cliCheck = vi.fn(() => { calls.push('cli.check'); return Promise.resolve(false) })
      const discover = vi.fn(async () => { calls.push('discover'); return { ok: true, installation: {} } })
      await openHelp(cliCheck, { installRecipes: vi.fn(async () => RECIPES), discover })
      const native = RECIPES[0]
      await act(async () => { byTest(`bottombar-recipe-run-${native.id}`)!.click() })
      expect(byTest(`bottombar-recipe-confirm-text-${native.id}`)!.textContent).toBe(
        'This downloads a script from claude.ai and runs it. Run this in a new terminal tab? It types the line below, and the app checks again when the command ends.',
      )
      expect(useSessionStore.getState().sessions).toEqual([])
      await act(async () => { byTest(`bottombar-recipe-confirm-run-${native.id}`)!.click() })
      await flush()
      const tabs = useSessionStore.getState().sessions
      expect(tabs).toHaveLength(1)
      expect(tabs[0]).toMatchObject({ label: 'Install Claude Code', shellOnly: true, transient: true, terminalOptions: { command: native.runLine, elevated: false, noCommandSecrets: true } })
      expect(shownTabs).toEqual([tabs[0].id])
      expect(byTest('bottombar-cli-help')).toBeNull()
      calls.length = 0
      act(() => { useSessionStore.getState().updateSession(tabs[0].id, { ptyExited: true }) })
      await flush()
      expect(discover).toHaveBeenCalledWith('claude')
      expect(calls).toEqual(['discover', 'cli.check'])
      // Still not found: the help opens again by itself and says so, with what to do (never a restart).
      expect(byTest('bottombar-cli-help')).not.toBeNull()
      expect(byTest('bottombar-cli-after-install')!.textContent).toBe(
        'The command ended, but Claude Code was still not found. The terminal shows what happened: fix what it reports and run it again, or try another command.',
      )
    } finally {
      window.removeEventListener(GO_TO_SESSION_EVENT, onGoTo)
      api.cli = before.cli
      api.providerAccounts = before.pa
    }
  })

  it('Check again asks main to check again before it reads the CLI; found, the help closes', async () => {
    const api = (globalThis as any).window.electronAPI
    const before = { cli: api.cli, pa: api.providerAccounts }
    try {
      const calls: string[] = []
      let available = false
      const cliCheck = vi.fn(() => { calls.push('cli.check'); return Promise.resolve(available) })
      const discover = vi.fn(async () => { calls.push('discover'); return { ok: true, installation: {} } })
      await openHelp(cliCheck, { installRecipes: vi.fn(async () => RECIPES), discover })
      expect(byTest('bottombar-cli-after-install')).toBeNull()
      calls.length = 0
      await act(async () => { byTest('bottombar-cli-recheck')!.click() })
      await flush()
      expect(calls).toEqual(['discover', 'cli.check'])
      expect(byTest('bottombar-cli-recheck')!.textContent).toBe('Check again')
      expect(byTest('bottombar-cli-after-install')!.textContent).toBe(
        'Claude Code was still not found. If you installed it another way, check that its folder is on your PATH, then press Check again.',
      )
      available = true
      await act(async () => { byTest('bottombar-cli-recheck')!.click() })
      await flush()
      expect(byTest('bottombar-cli-help')).toBeNull()
      expect(container.querySelector('[data-testid="bottom-bar-cli"]')!.getAttribute('title')).toBe('Claude CLI available')
    } finally {
      api.cli = before.cli
      api.providerAccounts = before.pa
    }
  })
})

describe('BottomBar: Claude Code installed in Anthropic\'s folder, off PATH', () => {
  const RECIPES = claudeInstallRecipes('win32').map((r) => installRecipeView(r, 'win32'))
  const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
  const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() }) }
  const HINT = { kind: 'add-to-path', folder: '%USERPROFILE%' + String.fromCharCode(92) + '.local' + String.fromCharCode(92) + 'bin' }

  it('the help names the folder and offers Add it to PATH for me, which sends only the provider id and checks again', async () => {
    const api = (globalThis as any).window.electronAPI
    const before = { cli: api.cli, pa: api.providerAccounts }
    try {
      let available = false
      api.cli = { check: vi.fn(() => Promise.resolve(available)) }
      const addToPath = vi.fn(async () => { available = true; return { ok: true, added: 'added', installation: {} } })
      api.providerAccounts = { installRecipes: vi.fn(async () => RECIPES), discover: vi.fn(async () => ({ ok: true, installation: {}, pathHint: HINT })), addToPath }
      useSessionStore.setState({ sessions: [], activeSessionId: null })
      await render()
      await act(async () => { (container.querySelector('[data-testid="bottom-bar-cli"]') as HTMLElement).click() })
      await flush()
      await act(async () => { byTest('bottombar-cli-recheck')!.click() })
      await flush()
      expect(byTest('bottombar-path-hint-text')!.textContent).toBe(
        'Claude Code is installed in %USERPROFILE%' + String.fromCharCode(92) + '.local' + String.fromCharCode(92) + 'bin, but that folder is not on your PATH yet, so this app and your terminals cannot find it. Add it to PATH for me adds that one folder to the end of your PATH for your Windows account; nothing else in it changes.',
      )
      expect(byTest('bottombar-cli-after-install')).toBeNull()
      expect(document.body.textContent).not.toContain('quit AI Code Conductor')
      await act(async () => { byTest('bottombar-path-add')!.click() })
      await flush()
      expect(addToPath).toHaveBeenCalledTimes(1)
      expect(addToPath).toHaveBeenCalledWith('claude')
      expect(byTest('bottombar-cli-help')).toBeNull()
    } finally {
      api.cli = before.cli
      api.providerAccounts = before.pa
    }
  })

  it('the help says where the app looks, on each platform: the PATH and Anthropic\'s folder', async () => {
    const { cliHelpLooksText } = await import('../../../src/renderer/onboarding/PathHintNotice')
    expect(cliHelpLooksText('win32')).toContain('%USERPROFILE%' + String.fromCharCode(92) + '.local' + String.fromCharCode(92) + 'bin')
    expect(cliHelpLooksText('win32')).toContain('the app offers to add it')
    expect(cliHelpLooksText('darwin')).toContain('~/.local/bin')
    expect(cliHelpLooksText('linux')).toContain('the app shows the line to add')
  })
})
