// @vitest-environment jsdom
/**
 * WP2 commit 6g: the retired Settings Codex tab showed the Codex CLI's
 * install command, to copy, whenever the CLI was not installed. That help
 * now lives on each provider's row of the Providers card (Settings, Accounts),
 * beside "Check again":
 *
 *   - a CLI main did not find (or that did not run, or could not be checked)
 *     gets the provider's own install commands, verbatim (on Windows npm is
 *     named npm.cmd, which PowerShell's script policy does not block), the
 *     publisher's own installer first, and where they come from; Claude Code
 *     included (ADR-024);
 *   - a CLI found but too old (or unsupported) gets the update commands;
 *   - a ready, unchecked or switched-off provider gets none, and main is not
 *     asked for them;
 *   - a provider with no command for this computer, or whose commands could
 *     not be read, shows none: its status line and Check again still say
 *     what is wrong;
 *   - every command has Run it for me and Copy (owner decision D2,
 *     2026-10-10): Run it for me asks first (naming the host an installer
 *     downloads its script from), then opens a visible terminal tab, shows
 *     it, and checks again when the tab ends; Copy copies the command
 *     exactly as shown.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { InstallRecipeView, ProviderInstallationView } from '../../../src/shared/providers'
import { codexInstallRecipes } from '../../../src/main/providers/codex/install-recipes'
import { claudeInstallRecipes } from '../../../src/main/providers/claude/install-recipes'
import { installRecipeView } from '../../../src/main/providers/core/recipe-run-line'
import { provider, snapshot } from './accounts-snapshot-harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Main's own recipes for Windows, as the IPC returns them (no argv).
const RECIPES: InstallRecipeView[] = codexInstallRecipes('win32').map((r) => installRecipeView(r, 'win32'))
const CLAUDE_RECIPES: InstallRecipeView[] = claudeInstallRecipes('win32').map((r) => installRecipeView(r, 'win32'))
const PS1 = 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'

const pa = {
  discover: vi.fn(async (_id: string) => ({ ok: true, installation: {} }) as Record<string, unknown>),
  addToPath: vi.fn(async (_id: string) => ({ ok: true, added: 'added', installation: {} }) as Record<string, unknown>),
  setEnabled: vi.fn(async () => ({ ok: true })),
  installRecipes: vi.fn(async (id: string) => (id === 'codex' ? RECIPES : CLAUDE_RECIPES)),
}
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, providerAccounts: pa }
const writeText = vi.fn(() => Promise.resolve())
Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true })

const { ProvidersCard, installPurpose, _resetProviderInstallTabsForTest } = await import('../../../src/renderer/components/settings/accounts/ProvidersCard')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { GO_TO_SESSION_EVENT } = await import('../../../src/renderer/lib/goToSession')

let container: HTMLDivElement
let root: Root
const shown: string[] = []
const onGoTo = (e: Event) => { shown.push((e as CustomEvent).detail.sessionId) }

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  pa.installRecipes.mockClear()
  pa.discover.mockClear()
  pa.discover.mockResolvedValue({ ok: true, installation: {} })
  pa.addToPath.mockClear()
  writeText.mockClear()
  useSessionStore.setState({ sessions: [], activeSessionId: null })
  // The tabs a row opened, and which of them ended, outlive the card (it is
  // unmounted while its tab is shown): forgotten between cases.
  _resetProviderInstallTabsForTest()
  shown.length = 0
  window.addEventListener(GO_TO_SESSION_EVENT, onGoTo)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  window.removeEventListener(GO_TO_SESSION_EVENT, onGoTo)
})

const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const codex = (over: Partial<ProviderInstallationView>) => provider({ providerId: 'codex', displayName: 'Codex', ...over })
const claude = (over: Partial<ProviderInstallationView> = {}) => provider({ providerId: 'claude', displayName: 'Claude Code', version: '2.1.281', ...over })

async function render(codexView: ProviderInstallationView, claudeView: ProviderInstallationView = claude()) {
  useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [claudeView, codexView] }), loaded: true })
  await act(async () => { root.render(<ProvidersCard />) })
  await act(async () => { await Promise.resolve() })
}
async function click(id: string) {
  await act(async () => { byTest(id)!.click() })
  await act(async () => { await Promise.resolve() })
}

const commands = (purpose: 'install' | 'update', id = 'codex') =>
  [...(byTest(`provider-${purpose}-commands-${id}`)?.querySelectorAll('[data-testid^="provider-recipe-command-"]') ?? [])].map((c) => c.textContent)

describe('Providers card: install and update commands (the retired Codex tab install hint)', () => {
  it("a Codex CLI main did not find shows its install commands, verbatim, OpenAI's installer first, with where they come from", async () => {
    await render(codex({ discoveryState: 'missing', version: undefined }))
    expect(pa.installRecipes).toHaveBeenCalledWith('codex')
    expect(commands('install')).toEqual([
      PS1,
      'npm.cmd install -g @openai/codex',
    ])
    expect(commands('update')).toEqual([])
    expect(byTest('provider-recipes-source-codex')!.textContent).toBe("Install Codex (from OpenAI's README): Run it for me checks again when it ends; after a command you copied, press Check again.")
    // Check again is still offered beside them.
    expect(byTest('provider-check-again-codex')).not.toBeNull()
  })

  it("a Claude Code CLI main did not find shows Anthropic's install commands: the native installer first, then npm", async () => {
    await render(codex({}), claude({ discoveryState: 'missing', version: undefined }))
    expect(pa.installRecipes).toHaveBeenCalledWith('claude')
    expect(commands('install', 'claude')).toEqual(['irm https://claude.ai/install.ps1 | iex', 'npm.cmd install -g @anthropic-ai/claude-code'])
    expect(byTest('provider-recipes-source-claude')!.textContent).toBe('Install Claude Code (from Anthropic): Run it for me checks again when it ends; after a command you copied, press Check again.')
  })

  it('a CLI that did not run, or could not be checked, gets the install commands too', async () => {
    for (const state of ['invalid', 'error'] as const) {
      await render(codex({ discoveryState: state }))
      expect(commands('install'), state).toHaveLength(2)
      act(() => { root.unmount() })
      root = createRoot(container)
    }
  })

  it('a CLI found too old, or unsupported, gets the update command instead', async () => {
    for (const compatibility of ['too-old', 'unsupported'] as const) {
      await render(codex({ version: '0.150.2', compatibility }))
      // Main's answer before it knows which install it found: every update.
      expect(commands('update'), compatibility).toEqual([
        PS1,
        'npm.cmd install -g @openai/codex@latest',
      ])
      expect(commands('install')).toEqual([])
      expect(byTest('provider-recipes-source-codex')!.textContent).toBe("Update Codex (from OpenAI's README): Run it for me checks again when it ends; after a command you copied, press Check again.")
      act(() => { root.unmount() })
      root = createRoot(container)
    }
  })

  it('a ready, newer-than-tested, unchecked or switched-off Codex shows none and never asks main', async () => {
    for (const view of [codex({}), codex({ compatibility: 'too-new' }), codex({ discoveryState: 'unchecked' }), codex({ enabled: false, discoveryState: 'missing' })]) {
      expect(installPurpose(view)).toBeNull()
      await render(view)
      expect(byTest('provider-install-commands-codex')).toBeNull()
      expect(byTest('provider-update-commands-codex')).toBeNull()
      act(() => { root.unmount() })
      root = createRoot(container)
    }
    expect(pa.installRecipes).not.toHaveBeenCalled()
  })

  it('a provider with no command for this computer, or whose commands could not be read, shows none', async () => {
    pa.installRecipes.mockImplementationOnce(async () => [])
    await render(codex({}), claude({ discoveryState: 'missing', version: undefined }))
    expect(pa.installRecipes).toHaveBeenCalledWith('claude')
    expect(byTest('provider-install-commands-claude')).toBeNull()
    expect(byTest('provider-check-again-claude')).not.toBeNull()
    act(() => { root.unmount() })
    root = createRoot(container)
    pa.installRecipes.mockImplementationOnce(async () => { throw new Error('ipc down') })
    await render(codex({ discoveryState: 'missing', version: undefined }))
    expect(byTest('provider-install-commands-codex')).toBeNull()
    expect(byTest('provider-check-again-codex')).not.toBeNull()
  })

  it("shows main's own note for each recipe, and Copy copies the command exactly as shown", async () => {
    await render(codex({ discoveryState: 'missing', version: undefined }))
    const ps1 = RECIPES.find((r) => r.id === 'codex-script-install-ps1')!
    expect(byTest('provider-recipe-note-codex-script-install-ps1')!.textContent).toBe(ps1.note)
    expect(byTest('provider-recipe-note-codex-npm-install')!.textContent).toContain('Needs Node.js. If npm says permission denied (EACCES), use the installer above instead')
    const copy = byTest('provider-recipe-copy-codex-npm-install')!
    await act(async () => { copy.click() })
    expect(writeText).toHaveBeenCalledWith('npm.cmd install -g @openai/codex')
    expect(copy.textContent).toBe('Copied')
  })

  it('a command main sent no line for says the app does not run it, and its Run it for me is off; one with a line says nothing extra', async () => {
    const bare = RECIPES.map(({ note: _n, runLine: _l, ...r }) => r)
    pa.installRecipes.mockImplementationOnce(async () => [...bare.slice(0, 1), ...RECIPES.slice(1)])
    await render(codex({ discoveryState: 'missing', version: undefined }))
    expect(byTest('provider-recipe-not-run-codex-script-install-ps1')!.textContent).toBe('The app does not run this command: copy it and run it in a terminal.')
    expect((byTest('provider-recipe-run-codex-script-install-ps1') as HTMLButtonElement).disabled).toBe(true)
    expect(byTest('provider-recipe-not-run-codex-npm-install')).toBeNull()
  })

  it('every command has Run it for me beside Copy', async () => {
    await render(codex({ discoveryState: 'missing', version: undefined }))
    for (const r of RECIPES.filter((x) => x.purpose === 'install')) {
      expect(byTest(`provider-recipe-run-${r.id}`)!.textContent, r.id).toBe('Run it for me')
      expect(byTest(`provider-recipe-copy-${r.id}`)!.textContent, r.id).toBe('Copy')
    }
  })

  it("Run it for me on an installer asks first, naming its host; Run it opens the tab, shows it, and checks again when it ends", async () => {
    await render(codex({}), claude({ discoveryState: 'missing', version: undefined }))
    const native = CLAUDE_RECIPES[0]
    await click(`provider-recipe-run-${native.id}`)
    expect(byTest(`provider-recipe-confirm-text-${native.id}`)!.textContent).toBe(
      'This downloads a script from claude.ai and runs it. Run this in a new terminal tab? It types the line below, and the app checks again when the command ends.',
    )
    expect(byTest(`provider-recipe-run-line-${native.id}`)!.textContent).toBe('$failed = $true; try { irm https://claude.ai/install.ps1 | iex; $failed = $false } catch { $_ } finally { if ($failed) { exit 1 } }; exit $LASTEXITCODE')
    expect(useSessionStore.getState().sessions).toEqual([])
    await click(`provider-recipe-confirm-run-${native.id}`)
    const tabs = useSessionStore.getState().sessions
    expect(tabs).toHaveLength(1)
    expect(tabs[0]).toMatchObject({ label: 'Install Claude Code', shellOnly: true, transient: true, terminalOptions: { command: native.runLine, elevated: false, noCommandSecrets: true } })
    expect(shown).toEqual([tabs[0].id])
    // While it runs, a second Run is off for that provider.
    expect((byTest(`provider-recipe-run-${CLAUDE_RECIPES[1].id}`) as HTMLButtonElement).disabled).toBe(true)
    expect(pa.discover).not.toHaveBeenCalled()
    // The line ends its shell when the command ends: the app checks again.
    act(() => { useSessionStore.getState().updateSession(tabs[0].id, { ptyExited: true }) })
    await act(async () => { await Promise.resolve() })
    expect(pa.discover).toHaveBeenCalledWith('claude')
    expect(pa.discover).toHaveBeenCalledTimes(1)
  })

  it('still not found after the command ended, or after Check again: the row says so, with what to do; not before', async () => {
    await render(codex({}), claude({ discoveryState: 'missing', version: undefined }))
    expect(byTest('provider-after-install-claude')).toBeNull()
    await click(`provider-recipe-run-${CLAUDE_RECIPES[1].id}`)
    await click(`provider-recipe-confirm-run-${CLAUDE_RECIPES[1].id}`)
    const tab = useSessionStore.getState().sessions[0]
    act(() => { useSessionStore.getState().removeSession(tab.id) })
    await act(async () => { await Promise.resolve() })
    // Main pushes the snapshot after the check: still missing.
    await act(async () => {
      useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [claude({ discoveryState: 'missing', version: undefined, lastCheckedAt: 9 }), codex({})] }), loaded: true })
    })
    await act(async () => { await Promise.resolve() })
    expect(byTest('provider-after-install-claude')!.textContent).toBe(
      'The command ended, but Claude Code was still not found. The terminal shows what happened: fix what it reports and run it again, or try another command.',
    )
    act(() => { root.unmount() })
    root = createRoot(container)
    await render(codex({ discoveryState: 'missing', version: undefined }))
    expect(byTest('provider-after-install-codex')).toBeNull()
    await click('provider-check-again-codex')
    expect(byTest('provider-after-install-codex')!.textContent).toBe(
      'Codex was still not found. If you installed it another way, check that its folder is on your PATH, then press Check again.',
    )
  })

  it('Node.js not found: the npm command says so and its Run it for me is off; Copy still works', async () => {
    pa.installRecipes.mockImplementation(async (id: string) => (id === 'codex' ? RECIPES : CLAUDE_RECIPES.map((r) => (r.id === 'claude-npm-install' ? { ...r, needsNode: true as const } : r))))
    try {
      await render(codex({}), claude({ discoveryState: 'missing', version: undefined }))
      expect((byTest('provider-recipe-run-claude-npm-install') as HTMLButtonElement).disabled).toBe(true)
      expect(byTest('provider-recipe-needs-node-claude-npm-install')!.textContent).toBe('Needs Node.js, which this app did not find on your PATH.')
      expect((byTest('provider-recipe-run-claude-script-install-ps1') as HTMLButtonElement).disabled).toBe(false)
      await click('provider-recipe-copy-claude-npm-install')
      expect(writeText).toHaveBeenCalledWith('npm.cmd install -g @anthropic-ai/claude-code')
    } finally {
      pa.installRecipes.mockImplementation(async (id: string) => (id === 'codex' ? RECIPES : CLAUDE_RECIPES))
    }
  })

  it('reads the commands again after each check: the update shown is the one for the install that check found', async () => {
    await render(codex({ version: '0.142.4', compatibility: 'too-old', lastCheckedAt: 1 }))
    expect(pa.installRecipes).toHaveBeenCalledTimes(1)
    // A later check found OpenAI's standalone install: main offers its installer again, not npm.
    pa.installRecipes.mockImplementationOnce(async () => codexInstallRecipes('win32', { executable: 'C:\\Users\\u\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe' }).map((r) => installRecipeView(r, 'win32')))
    await act(async () => {
      useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [claude(), codex({ version: '0.142.4', compatibility: 'too-old', lastCheckedAt: 2 })] }), loaded: true })
    })
    await act(async () => { await Promise.resolve() })
    expect(pa.installRecipes).toHaveBeenCalledTimes(2)
    expect(commands('update')).toEqual([PS1])
  })

  it('WP2 commit 6g: an unchecked CLI shows Check again but no commands; once main says missing, the install commands appear', async () => {
    await render(codex({ discoveryState: 'unchecked', version: undefined }))
    expect(byTest('provider-check-again-codex')).not.toBeNull()
    expect(byTest('provider-install-commands-codex')).toBeNull()
    expect(pa.installRecipes).not.toHaveBeenCalled()
    // Main's start-up discovery pushes its answer as a new snapshot.
    await act(async () => {
      useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [claude(), codex({ discoveryState: 'missing', version: undefined })] }), loaded: true })
    })
    await act(async () => { await Promise.resolve() })
    expect(commands('install')).toHaveLength(2)
  })

  it('the Copied label clears itself, and its timer does not outlive the card', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await render(codex({ discoveryState: 'missing', version: undefined }))
      const copy = byTest('provider-recipe-copy-codex-npm-install')!
      await act(async () => { copy.click() })
      expect(copy.textContent).toBe('Copied')
      await act(async () => { vi.advanceTimersByTime(1600) })
      expect(copy.textContent).toBe('Copy')
      await act(async () => { byTest('provider-recipe-copy-codex-npm-install')!.click() })
      expect(vi.getTimerCount()).toBe(1)
      act(() => { root.unmount() })
      expect(vi.getTimerCount()).toBe(0)
      root = createRoot(container)
    } finally {
      vi.useRealTimers()
    }
  })
})

// The PATH finding of the first-run test (2026-10-10; ADR-024): a check that
// still does not find Claude Code, though Anthropic's installer put it in its
// own folder, says so on the row, with Add it to PATH for me; the row sends
// main only the provider id. No restart is advised unless main says so.
describe('Providers card: a CLI in its publisher\'s folder, off PATH', () => {
  const BSL = String.fromCharCode(92)
  const HINT = { kind: 'add-to-path', folder: '%USERPROFILE%' + BSL + '.local' + BSL + 'bin' }

  it('after Check again: the row names the folder and offers Add it to PATH for me, for that provider only', async () => {
    pa.discover.mockResolvedValue({ ok: true, installation: {}, pathHint: HINT })
    await render(codex({}), claude({ discoveryState: 'missing', version: undefined }))
    await click('provider-check-again-claude')
    expect(byTest('provider-claude-path-hint-text')!.textContent).toContain('Claude Code is installed in %USERPROFILE%' + BSL + '.local' + BSL + 'bin, but that folder is not on your PATH yet')
    expect(byTest('provider-after-install-claude')).toBeNull()
    expect(container.textContent).not.toContain('quit AI Code Conductor')
    await click('provider-claude-path-add')
    expect(pa.addToPath).toHaveBeenCalledTimes(1)
    expect(pa.addToPath.mock.calls[0]).toEqual(['claude'])
  })

  it('after an install tab ends, even with the card away: the check\'s hint is shown when the card comes back', async () => {
    pa.discover.mockResolvedValue({ ok: true, installation: {}, pathHint: HINT })
    await render(codex({}), claude({ discoveryState: 'missing', version: undefined }))
    await click(`provider-recipe-run-${CLAUDE_RECIPES[0].id}`)
    await click(`provider-recipe-confirm-run-${CLAUDE_RECIPES[0].id}`)
    const tab = useSessionStore.getState().sessions[0]
    act(() => { root.unmount() })
    act(() => { useSessionStore.getState().updateSession(tab.id, { ptyExited: true }) })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(pa.discover).toHaveBeenCalledWith('claude')
    root = createRoot(container)
    await render(codex({}), claude({ discoveryState: 'missing', version: undefined, lastCheckedAt: 5 }))
    expect(byTest('provider-claude-path-add')).not.toBeNull()
  })

  it('a restart is advised only when main says it would help', async () => {
    pa.discover.mockResolvedValue({ ok: true, installation: {}, pathHint: { kind: 'restart' } })
    await render(codex({ discoveryState: 'missing', version: undefined }))
    await click('provider-check-again-codex')
    expect(byTest('provider-codex-path-restart')!.textContent).toContain('Quit AI Code Conductor and start it again')
  })
})
