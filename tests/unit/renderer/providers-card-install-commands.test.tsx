// @vitest-environment jsdom
/**
 * WP2 commit 6g: the retired Settings Codex tab showed the Codex CLI's
 * install command, to copy, whenever the CLI was not installed. That help
 * now lives on the Codex row of the Providers card (Settings, Accounts),
 * beside "Check again":
 *
 *   - a CLI main did not find (or that did not run, or could not be checked)
 *     gets the provider's own install commands, verbatim, each with Copy,
 *     and where they come from;
 *   - a CLI found but too old (or unsupported) gets the update commands;
 *   - a ready, unchecked or switched-off provider gets none, and main is not
 *     asked for them;
 *   - a provider with no command for this computer (Claude Code here), or
 *     whose commands could not be read, shows none: its status line and
 *     Check again still say what is wrong;
 *   - a script recipe says the app does not run it; Copy copies the command
 *     exactly as shown.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { InstallRecipeView, ProviderInstallationView } from '../../../src/shared/providers'
import { codexInstallRecipes } from '../../../src/main/providers/codex/install-recipes'
import { provider, snapshot } from './accounts-snapshot-harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Main's own recipes for Windows, as the IPC returns them (no argv).
const RECIPES: InstallRecipeView[] = codexInstallRecipes('win32').map((r) => ({
  id: r.id, providerId: r.providerId, purpose: r.purpose, publisher: r.publisher, sourceUrl: r.sourceUrl, displayCommand: r.displayCommand,
  method: r.method, needsNetwork: r.needsNetwork, mayElevate: r.mayElevate, autoRunAllowed: r.autoRunAllowed, ...(r.note !== undefined ? { note: r.note } : {}),
}))

const pa = {
  discover: vi.fn(async () => ({ ok: true, installation: {} })),
  setEnabled: vi.fn(async () => ({ ok: true })),
  installRecipes: vi.fn(async (id: string) => (id === 'codex' ? RECIPES : [])),
}
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, providerAccounts: pa }
const writeText = vi.fn(() => Promise.resolve())
Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true })

const { ProvidersCard, installPurpose, SCRIPT_NOTE } = await import('../../../src/renderer/components/settings/accounts/ProvidersCard')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  pa.installRecipes.mockClear()
  writeText.mockClear()
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const codex = (over: Partial<ProviderInstallationView>) => provider({ providerId: 'codex', displayName: 'Codex', ...over })
const claude = (over: Partial<ProviderInstallationView> = {}) => provider({ providerId: 'claude', displayName: 'Claude Code', version: '2.1.281', ...over })

async function render(codexView: ProviderInstallationView, claudeView: ProviderInstallationView = claude()) {
  useProviderAccountsStore.setState({ snapshot: snapshot({ providers: [claudeView, codexView] }), loaded: true })
  await act(async () => { root.render(<ProvidersCard />) })
  await act(async () => { await Promise.resolve() })
}

const commands = (purpose: 'install' | 'update', id = 'codex') =>
  [...(byTest(`provider-${purpose}-commands-${id}`)?.querySelectorAll('[data-testid^="provider-recipe-command-"]') ?? [])].map((c) => c.textContent)

describe('Providers card: install and update commands (the retired Codex tab install hint)', () => {
  it('a Codex CLI main did not find shows its install commands, verbatim, with where they come from', async () => {
    await render(codex({ discoveryState: 'missing', version: undefined }))
    expect(pa.installRecipes).toHaveBeenCalledWith('codex')
    expect(commands('install')).toEqual([
      'npm install -g @openai/codex',
      'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"',
    ])
    expect(commands('update')).toEqual([])
    expect(byTest('provider-recipes-source-codex')!.textContent).toBe("Install Codex (from OpenAI's README), then Check again.")
    // Check again is still offered beside them.
    expect(byTest('provider-check-again-codex')).not.toBeNull()
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
      expect(commands('update'), compatibility).toEqual(['npm install -g @openai/codex@latest'])
      expect(commands('install')).toEqual([])
      expect(byTest('provider-recipes-source-codex')!.textContent).toBe("Update Codex (from OpenAI's README), then Check again.")
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
    expect(byTest('provider-recipe-note-codex-npm-install')!.textContent).toContain('Needs Node.js and npm')
    const copy = byTest('provider-recipe-copy-codex-npm-install')!
    await act(async () => { copy.click() })
    expect(writeText).toHaveBeenCalledWith('npm install -g @openai/codex')
    expect(copy.textContent).toBe('Copied')
  })

  it('a script recipe that arrives without a note still says the app does not run it; a package-manager one without a note says nothing', async () => {
    const bare = RECIPES.map(({ note: _n, ...r }) => r)
    pa.installRecipes.mockImplementationOnce(async () => bare)
    await render(codex({ discoveryState: 'missing', version: undefined }))
    expect(byTest('provider-recipe-note-codex-script-install-ps1')!.textContent).toBe(SCRIPT_NOTE)
    expect(byTest('provider-recipe-note-codex-npm-install')).toBeNull()
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
