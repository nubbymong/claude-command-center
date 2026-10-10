// @vitest-environment jsdom
/**
 * WP2 commit 6e (canvas F2): the onboarding "Set up Codex" page, driven by
 * the Accounts snapshot's Codex installation and the providerAccounts IPC
 * (mocked here), with main's real Codex install recipes.
 *
 * Verifies:
 *   - entry checks again (discover) and reads the recipes; each return from
 *     the terminal checks again;
 *   - not found: the install recipes verbatim; the package-manager one runs
 *     in a terminal, the script is Copy only with its note; Check again;
 *   - Run in a terminal asks first, then opens a VISIBLE shell-only terminal
 *     tab (the active session) with the exact command, never elevated, and
 *     the harness steps aside; Cancel runs nothing;
 *   - too old: the version found (no minimum: the snapshot has none), the
 *     update recipe, Check again;
 *   - ready: the version rows and the three sign-in methods, which open the
 *     Accounts surface's own add-account dialog at that method, above the
 *     onboarding page;
 *   - this computer's sign-in (fixtures as main produces them after the
 *     choice: Codex on): opening the page asks main once, READ-ONLY, whether
 *     it is signed in (probeExternal: nothing registered, no yes recorded;
 *     owner decision 2026-09-26), whatever an earlier answer recorded, and
 *     asks once only (StrictMode, an unmount, a pushed record meanwhile, the
 *     CLI found later); then offers canvas F2 d as signed in, the sign-in
 *     choices with a note when it is signed out (its "check again" asks the
 *     same read-only question, never adopts), nothing when there is no folder
 *     or Codex cannot check it here, a note when the folder overlaps the
 *     app's own, and F2 d without the claim when there was no answer; only
 *     "Use this sign-in" takes it in (main asks its status, then registers),
 *     landing on F2 d settled, or on the sign-in choices with a note when it
 *     is signed out (its "check again" is that choice, asked again);
 *   - signed in: done, and Next continues (no Skip);
 *   - the no-registry state says so once; the update list says "update".
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { AccountsSnapshot, InstallRecipeView, ProviderInstallationView } from '../../../src/shared/providers'
import { codexInstallRecipes } from '../../../src/main/providers/codex/install-recipes'
import { installRecipeView } from '../../../src/main/providers/core/recipe-run-line'
import { provider, account, snapshot, claudeMain } from './accounts-snapshot-harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Main's own recipes for Windows, as the IPC returns them (no argv): the line
// to type (`runLine`) only where main allows the recipe to run, built by main.
const RECIPES: InstallRecipeView[] = codexInstallRecipes('win32').map((r) => installRecipeView(r, 'win32'))
const NPM_INSTALL = RECIPES.find((r) => r.id === 'codex-npm-install')!
const PS1 = RECIPES.find((r) => r.id === 'codex-script-install-ps1')!
const NPM_UPDATE = RECIPES.find((r) => r.id === 'codex-npm-update')!
// What Windows types: npm.cmd, not the npm.ps1 PowerShell's execution policy
// refuses to load, and the line ends its shell however the command ends
// (ADR-024). Not the command the user is shown.
const WIN = (cmd: string) => `$failed = $true; try { ${cmd}; $failed = $false } catch { $_ } finally { if ($failed) { exit 1 } }; exit $LASTEXITCODE`
const NPM_INSTALL_LINE = WIN("npm.cmd 'install' '-g' '@openai/codex'")
const NPM_UPDATE_LINE = WIN("npm.cmd 'install' '-g' '@openai/codex@latest'")
// OpenAI's own installer, typed as its README writes it.
const PS1_LINE = WIN('powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"')

const ok = () => Promise.resolve({ ok: true })
const pa = {
  snapshot: vi.fn(),
  onChanged: vi.fn(() => () => {}),
  discover: vi.fn(),
  installRecipes: vi.fn(async () => RECIPES),
  probeExternal: vi.fn<(id: string) => Promise<{ ok: boolean; state?: string; code?: string; message?: string }>>(),
  setEnabled: vi.fn(ok),
  adoptExternal: vi.fn(async () => ({ ok: true, accountId: 'acc-ext' })),
  beginSetup: vi.fn(async () => ({ ok: true, accountId: 'acc-new' })),
  signIn: vi.fn(() => new Promise(() => {})),
  onSignInOutput: vi.fn(() => () => {}),
  cancelSignIn: vi.fn(ok),
  abandonSetup: vi.fn(ok),
  completeSetup: vi.fn(),
  issueSecretHandle: vi.fn(),
  sendSecret: vi.fn(),
}
const writeText = vi.fn(async () => undefined)
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, providerAccounts: pa }
// The durable yes the check may need first saves the setting; nothing reaches disk here.
vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn() }))
Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true })

const { CodexSetupStep } = await import('../../../src/renderer/onboarding/CodexSetupStep')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

let container: HTMLDivElement
let root: Root
const onNext = vi.fn()
const onBack = vi.fn()
const stepAside = vi.fn()

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

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  for (const f of Object.values(pa)) f.mockClear()
  pa.discover.mockReset()
  // By default the check agrees with the snapshot it was given.
  pa.discover.mockImplementation(async () => ({ ok: true, installation: useProviderAccountsStore.getState().snapshot!.providers[1] }))
  pa.installRecipes.mockResolvedValue(RECIPES)
  // By default the page's read-only check finds this computer's sign-in signed in.
  pa.probeExternal.mockReset()
  pa.probeExternal.mockResolvedValue({ ok: true, state: 'signed-in' })
  // The snapshot fetched after a check: by default nothing newer than what the page has.
  pa.snapshot.mockReset()
  pa.snapshot.mockResolvedValue(null)
  writeText.mockClear()
  onNext.mockReset()
  onBack.mockReset()
  stepAside.mockReset()
  useSessionStore.setState({ sessions: [], activeSessionId: null })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
})

const byTest = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
}

async function render(s: AccountsSnapshot | null, returns = 0) {
  useProviderAccountsStore.setState({ snapshot: s, loaded: true })
  await act(async () => {
    root.render(<CodexSetupStep onNext={onNext} onBack={onBack} stepAside={stepAside} returns={returns} />)
  })
  await flush()
}

async function click(id: string) {
  await act(async () => { byTest(id)!.click() })
  await flush()
}

describe('entry', () => {
  it('checks the CLI again and reads the install recipes', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(pa.discover).toHaveBeenCalledWith('codex')
    expect(pa.installRecipes).toHaveBeenCalledWith('codex')
  })

  it('shows "checking" while main has not looked yet', async () => {
    pa.discover.mockImplementation(() => new Promise(() => {}))
    await render(snap({ discoveryState: 'unchecked', version: undefined }))
    expect(byTest('codex-setup-checking')!.textContent).toContain('Checking for the Codex CLI')
  })

  it('each return from the terminal checks again', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(pa.discover).toHaveBeenCalledTimes(1)
    await act(async () => {
      root.render(<CodexSetupStep onNext={onNext} onBack={onBack} stepAside={stepAside} returns={1} />)
    })
    await flush()
    expect(pa.discover).toHaveBeenCalledTimes(2)
  })
})

describe('Codex CLI not found', () => {
  it('says so and lists the install recipes verbatim, never the update ones', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(byTest('codex-setup-check')!.textContent).toBe('!Codex CLI not found')
    expect(byTest('codex-recipes-install')!.textContent).toContain("From OpenAI's README")
    expect(byTest(`codex-recipe-command-${NPM_INSTALL.id}`)!.textContent).toBe(NPM_INSTALL.displayCommand)
    expect(byTest(`codex-recipe-command-${PS1.id}`)!.textContent).toBe(PS1.displayCommand)
    expect(byTest(`codex-recipe-${NPM_UPDATE.id}`)).toBeNull()
    expect(byTest('codex-recipes-update')).toBeNull()
  })

  it("every command offers Run it for me and Copy, OpenAI's installer first, each with main's note", async () => {
    expect(NPM_INSTALL.runLine).toBe(NPM_INSTALL_LINE)
    expect(PS1.runLine).toBe(PS1_LINE)
    await render(snap({ discoveryState: 'missing', version: undefined }))
    const rows = [...byTest('codex-recipes-install')!.querySelectorAll('[data-testid^="codex-recipe-command-"]')].map((c) => c.textContent)
    expect(rows).toEqual([PS1.displayCommand, NPM_INSTALL.displayCommand])
    for (const r of [PS1, NPM_INSTALL]) {
      expect(byTest(`codex-recipe-run-${r.id}`)!.textContent, r.id).toBe('Run it for me')
      expect((byTest(`codex-recipe-run-${r.id}`) as HTMLButtonElement).disabled, r.id).toBe(false)
      expect(byTest(`codex-recipe-copy-${r.id}`)!.textContent, r.id).toBe('Copy')
      expect(byTest(`codex-recipe-note-${r.id}`)!.textContent, r.id).toBe(r.note)
    }
  })

  it("whether a recipe runs is main's call: one main sent no line for has Run it for me off, saying why; Copy still works", async () => {
    const { runLine: _dropped, ...noLine } = NPM_INSTALL
    pa.installRecipes.mockResolvedValue([noLine, PS1])
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(noLine.method).toBe('package-manager')
    expect(noLine.autoRunAllowed).toBe(true)
    const run = byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(byTest(`codex-recipe-not-run-${NPM_INSTALL.id}`)!.textContent).toBe('The app does not run this command: copy it and run it in a terminal.')
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    expect(byTest(`codex-recipe-confirm-${NPM_INSTALL.id}`)).toBeNull()
    expect(byTest(`codex-recipe-copy-${NPM_INSTALL.id}`)!.textContent).toBe('Copy')
    await click(`codex-recipe-copy-${NPM_INSTALL.id}`)
    // Copy is the shown command, verbatim.
    expect(writeText).toHaveBeenCalledWith(NPM_INSTALL.displayCommand)
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('a script that arrives without the host it downloads from is not run: the confirmation could not name it', async () => {
    const { downloadsFrom: _dropped, ...noHost } = PS1
    pa.installRecipes.mockResolvedValue([noHost, NPM_INSTALL])
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect((byTest(`codex-recipe-run-${PS1.id}`) as HTMLButtonElement).disabled).toBe(true)
    expect((byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement).disabled).toBe(false)
  })

  it("Run it for me on OpenAI's installer asks first, naming chatgpt.com and saying it downloads and runs a script; only Run it types its line", async () => {
    expect(PS1.downloadsFrom).toBe('chatgpt.com')
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${PS1.id}`)
    expect(byTest(`codex-recipe-confirm-text-${PS1.id}`)!.textContent).toBe(
      'This downloads a script from chatgpt.com and runs it. Run this in a new terminal tab? It types the line below. Setup steps aside so you can watch it, and you come back to it when you are done.',
    )
    expect(byTest(`codex-recipe-run-line-${PS1.id}`)!.textContent).toBe(PS1_LINE)
    expect(useSessionStore.getState().sessions).toEqual([])
    await click(`codex-recipe-cancel-${PS1.id}`)
    expect(useSessionStore.getState().sessions).toEqual([])
    await click(`codex-recipe-run-${PS1.id}`)
    await click(`codex-recipe-confirm-run-${PS1.id}`)
    const s = useSessionStore.getState().sessions
    expect(s).toHaveLength(1)
    expect(s[0].terminalOptions).toEqual({ command: PS1_LINE, elevated: false, noCommandSecrets: true })
    expect(s[0].label).toBe('Install Codex')
  })

  it('a package-manager command asks first too, without the script sentence', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    expect(byTest(`codex-recipe-confirm-text-${NPM_INSTALL.id}`)!.textContent).toBe(
      'Run this in a new terminal tab? It types the line below. Setup steps aside so you can watch it, and you come back to it when you are done.',
    )
  })

  it('Node.js not found: the npm command says so and its Run it for me is off; Copy still works; the installer still runs', async () => {
    pa.installRecipes.mockResolvedValue([PS1, { ...NPM_INSTALL, needsNode: true }])
    await render(snap({ discoveryState: 'missing', version: undefined }))
    const run = byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(run.title).toBe('Needs Node.js, which this app did not find on your PATH.')
    expect(byTest(`codex-recipe-needs-node-${NPM_INSTALL.id}`)!.textContent).toBe('Needs Node.js, which this app did not find on your PATH.')
    await click(`codex-recipe-copy-${NPM_INSTALL.id}`)
    expect(writeText).toHaveBeenCalledWith(NPM_INSTALL.displayCommand)
    expect((byTest(`codex-recipe-run-${PS1.id}`) as HTMLButtonElement).disabled).toBe(false)
    expect(byTest(`codex-recipe-needs-node-${PS1.id}`)).toBeNull()
  })

  it('Copy puts the exact script command on the clipboard and runs nothing', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-copy-${PS1.id}`)
    expect(writeText).toHaveBeenCalledWith(PS1.displayCommand)
    expect(byTest(`codex-recipe-copy-${PS1.id}`)!.textContent).toBe('Copied')
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(stepAside).not.toHaveBeenCalled()
  })

  it('Run it for me asks first, showing the line it will type; Cancel runs nothing', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    expect(byTest(`codex-recipe-confirm-${NPM_INSTALL.id}`)).not.toBeNull()
    expect(byTest(`codex-recipe-run-line-${NPM_INSTALL.id}`)!.textContent).toBe(NPM_INSTALL_LINE)
    // The page still shows the documented command, verbatim.
    expect(byTest(`codex-recipe-command-${NPM_INSTALL.id}`)!.textContent).toBe(NPM_INSTALL.displayCommand)
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(stepAside).not.toHaveBeenCalled()
    await click(`codex-recipe-cancel-${NPM_INSTALL.id}`)
    expect(byTest(`codex-recipe-confirm-${NPM_INSTALL.id}`)).toBeNull()
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it("confirmed, it opens a visible shell-only terminal typing main's line exactly, and the setup steps aside", async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    await click(`codex-recipe-confirm-run-${NPM_INSTALL.id}`)
    const { sessions, activeSessionId } = useSessionStore.getState()
    expect(sessions).toHaveLength(1)
    const s = sessions[0]
    expect(s.shellOnly).toBe(true)
    expect(s.sessionType).toBe('local')
    // Transient: never saved or resumed, and its command runs once (transient-terminal.test.tsx).
    expect(s.transient).toBe(true)
    // The line main built (npm.cmd on Windows), never the shown command.
    // No command-button secrets in its shell: the install script is a third party's.
    expect(s.terminalOptions).toEqual({ command: NPM_INSTALL_LINE, elevated: false, noCommandSecrets: true })
    expect(s.terminalOptions!.command).not.toBe(NPM_INSTALL.displayCommand)
    expect(s.label).toBe('Install Codex')
    expect(activeSessionId).toBe(s.id)
    expect(stepAside).toHaveBeenCalledTimes(1)
  })

  it('while the tab it opened is open, Run is off for the page and says where it is running', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    await click(`codex-recipe-confirm-run-${NPM_INSTALL.id}`)
    const tab = useSessionStore.getState().sessions[0]
    // Back from the terminal: the page checks again, and cannot start a second install.
    await act(async () => {
      root.render(<CodexSetupStep onNext={onNext} onBack={onBack} stepAside={stepAside} returns={1} />)
    })
    await flush()
    const run = byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement
    expect(run.disabled).toBe(true)
    expect(run.title).toBe('Already running in the Install Codex tab')
    expect(byTest(`codex-recipe-busy-${NPM_INSTALL.id}`)!.textContent).toBe('Already running in the Install Codex tab')
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    expect(byTest(`codex-recipe-confirm-${NPM_INSTALL.id}`)).toBeNull()
    expect(useSessionStore.getState().sessions).toHaveLength(1)

    // Shown again later (Back, then Next): the page still knows.
    act(() => { root.unmount() })
    root = createRoot(container)
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect((byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement).disabled).toBe(true)

    // The tab closed: Run is back.
    act(() => { useSessionStore.getState().removeSession(tab.id) })
    await flush()
    const again = byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement
    expect(again.disabled).toBe(false)
    expect(again.title).toBe('')
    expect(byTest(`codex-recipe-busy-${NPM_INSTALL.id}`)).toBeNull()
  })

  it("once the tab's shell exits (the line ends it), Run is back and the page checks again, once", async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    await click(`codex-recipe-confirm-run-${NPM_INSTALL.id}`)
    const tab = useSessionStore.getState().sessions[0]
    expect((byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement).disabled).toBe(true)
    const before = pa.discover.mock.calls.length
    act(() => { useSessionStore.getState().updateSession(tab.id, { ptyExited: true }) })
    await flush()
    expect(pa.discover.mock.calls.length).toBe(before + 1)
    expect((byTest(`codex-recipe-run-${NPM_INSTALL.id}`) as HTMLButtonElement).disabled).toBe(false)
    expect(byTest(`codex-recipe-busy-${NPM_INSTALL.id}`)).toBeNull()
    // Still not found after it ended: the page says so, with what to do.
    expect(byTest('codex-setup-after-install')!.textContent).toBe(
      'The command ended, but Codex was still not found. The terminal shows what happened: fix what it reports and run it again, or try another command.',
    )
    // The same end is not checked twice.
    act(() => { useSessionStore.getState().updateSession(tab.id, { label: 'Install Codex (ended)' }) })
    await flush()
    expect(pa.discover.mock.calls.length).toBe(before + 1)
  })

  it('the tab closed while its command ran: the page checks again, and a Codex found then moves it on', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    await click(`codex-recipe-confirm-run-${NPM_INSTALL.id}`)
    const tab = useSessionStore.getState().sessions[0]
    pa.discover.mockResolvedValueOnce({ ok: true, installation: codex({ discoveryState: 'found', version: '0.155.1', compatibility: 'supported', lastCheckedAt: 5 }) })
    const before = pa.discover.mock.calls.length
    act(() => { useSessionStore.getState().removeSession(tab.id) })
    await flush()
    expect(pa.discover.mock.calls.length).toBe(before + 1)
    expect(byTest('codex-setup-missing')).toBeNull()
    expect(byTest('codex-setup-after-install')).toBeNull()
  })

  it('nothing is said before anything was tried; Check again that still finds nothing says what to check, never a restart', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(byTest('codex-setup-after-install')).toBeNull()
    await click('codex-setup-check-again')
    expect(byTest('codex-setup-after-install')!.textContent).toBe(
      'Codex was still not found. If you installed it another way, check that its folder is on your PATH, then press Check again.',
    )
    expect(document.body.textContent).not.toContain('quit AI Code Conductor')
  })

  // The PATH finding of the first-run test (2026-10-10; ADR-024): on Linux
  // OpenAI's installer writes its PATH line to a file a login shell does not
  // read, so ~/.local/bin/codex can be missed. The page says which file the
  // login shell reads and the line to add, with Copy; it never edits it.
  it('Codex in ~/.local/bin, which the login shell misses: the page names the file and the line, with Copy', async () => {
    const line = 'export PATH="$HOME/.local/bin:$PATH"'
    pa.discover.mockResolvedValue({ ok: true, installation: codex({ discoveryState: 'missing', version: undefined }), pathHint: { kind: 'shell-profile', folder: '~/.local/bin', file: '~/.bashrc', line } })
    try {
      await render(snap({ discoveryState: 'missing', version: undefined }))
      await click('codex-setup-check-again')
      expect(byTest('codex-path-hint-text')!.textContent).toBe(
        'Codex is installed in ~/.local/bin, but the PATH your login shell builds does not include that folder, so this app cannot find it. Add this line to ~/.bashrc, then press Check again. The app does not change that file.',
      )
      expect(byTest('codex-path-line')!.textContent).toBe(line)
      expect(byTest('codex-setup-after-install')).toBeNull()
      await click('codex-path-copy')
      expect(writeText).toHaveBeenCalledWith(line)
    } finally {
      pa.discover.mockReset()
    }
  })

  it('a second Run it before the page re-renders opens no second tab', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-run-${NPM_INSTALL.id}`)
    const confirm = byTest(`codex-recipe-confirm-run-${NPM_INSTALL.id}`)!
    // Two clicks inside one act: the second lands on the same, not yet re-rendered, button.
    await act(async () => { confirm.click(); confirm.click() })
    await flush()
    expect(useSessionStore.getState().sessions).toHaveLength(1)
    expect(stepAside).toHaveBeenCalledTimes(1)
  })

  it('with no page before it there is no Back button', async () => {
    useProviderAccountsStore.setState({ snapshot: snap({ discoveryState: 'missing', version: undefined }), loaded: true })
    await act(async () => {
      root.render(<CodexSetupStep onNext={onNext} stepAside={stepAside} returns={0} />)
    })
    await flush()
    expect(byTest('codex-setup-back')).toBeNull()
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(byTest('codex-setup-back')).not.toBeNull()
  })

  it('Check again looks again, and a CLI found since moves the page on', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    pa.discover.mockResolvedValueOnce({ ok: true, installation: codex({ discoveryState: 'found', version: '0.155.1', compatibility: 'supported', lastCheckedAt: 2 }) })
    await click('codex-setup-check-again')
    expect(pa.discover).toHaveBeenCalledTimes(2)
    expect(byTest('codex-setup-missing')).toBeNull()
    expect(byTest('codex-setup-sign-in')).not.toBeNull()
  })

  it('the page can be skipped', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click('codex-setup-skip')
    expect(onNext).toHaveBeenCalledTimes(1)
  })
})

describe('the commands follow the install each check found', () => {
  it('reads the commands again after every check, so an update offered is the one for the install found then', async () => {
    await render(snap({ discoveryState: 'found', version: '0.142.4', compatibility: 'too-old', lastCheckedAt: 1 }))
    expect(pa.installRecipes).toHaveBeenCalledTimes(1)
    pa.discover.mockResolvedValueOnce({ ok: true, installation: codex({ discoveryState: 'found', version: '0.142.4', compatibility: 'too-old', lastCheckedAt: 2 }) })
    pa.installRecipes.mockResolvedValueOnce(RECIPES.filter((r) => r.id !== NPM_UPDATE.id))
    await click('codex-setup-check-again')
    expect(pa.installRecipes).toHaveBeenCalledTimes(2)
    expect(byTest(`codex-recipe-${NPM_UPDATE.id}`)).toBeNull()
    expect(byTest('codex-recipe-codex-script-update-ps1')).not.toBeNull()
  })
})

describe('Codex too old', () => {
  it('names the version found (no minimum: the snapshot has none) and offers the update recipe', async () => {
    await render(snap({ discoveryState: 'found', version: '0.150.2', compatibility: 'too-old' }))
    expect(byTest('codex-setup-check')!.textContent).toBe('!Codex 0.150.2 found; it is too old for this app')
    expect(byTest(`codex-recipe-command-${NPM_UPDATE.id}`)!.textContent).toBe(NPM_UPDATE.displayCommand)
    expect(byTest(`codex-recipe-run-${NPM_UPDATE.id}`)).not.toBeNull()
    expect(byTest('codex-recipes-install')).toBeNull()
    expect(byTest('codex-setup-check-again')).not.toBeNull()
  })

  it('the update runs in a terminal labelled for it, after confirming', async () => {
    await render(snap({ discoveryState: 'found', version: '0.150.2', compatibility: 'too-old' }))
    await click(`codex-recipe-run-${NPM_UPDATE.id}`)
    expect(byTest(`codex-recipe-run-line-${NPM_UPDATE.id}`)!.textContent).toBe(NPM_UPDATE_LINE)
    await click(`codex-recipe-confirm-run-${NPM_UPDATE.id}`)
    const s = useSessionStore.getState().sessions[0]
    expect(s.terminalOptions).toEqual({ command: NPM_UPDATE_LINE, elevated: false, noCommandSecrets: true })
    expect(s.label).toBe('Update Codex')
  })
})

describe('ready to sign in', () => {
  it('the version rows and the three methods, ChatGPT first; Skip for now continues', async () => {
    await render(snap({}))
    expect(byTest('codex-setup-found')!.textContent).toBe(`${CHECK}Codex 0.155.1 found`)
    expect(byTest('codex-setup-version')!.textContent).toBe(`${CHECK}Version supported`)
    expect(byTest('codex-setup-sign-in')!.textContent).toContain('Sign in to a new Codex account')
    expect(byTest('codex-setup-method-browser')!.textContent).toBe('Sign in with ChatGPTopens your browser')
    expect(byTest('codex-setup-method-device')!.textContent).toBe('Use a device codefor a browser on another device')
    expect(byTest('codex-setup-method-apiKey')!.textContent).toBe('Use an API keythe key goes to Codex; this app never stores it')
    expect(byTest('codex-setup-check-again')).toBeNull()
    await click('codex-setup-skip')
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('a CLI newer than tested is usable, with a warning', async () => {
    await render(snap({ version: '0.157.0', compatibility: 'too-new' }))
    expect(byTest('codex-setup-version')!.textContent).toContain('Newer than the versions this app was tested with; it will still be used')
    // A caution, in the amber Settings, Accounts shows for the same state; never the blue "wait" badge.
    expect(byTest('codex-setup-version')!.querySelector('.badge')!.className).toBe('badge warn')
    expect(byTest('codex-setup-sign-in')).not.toBeNull()
  })

  it('a method opens the add-account dialog, above the page, and starts that method there', async () => {
    await render(snap({}))
    await click('codex-setup-method-device')
    expect(byTest('add-account-dialog')).not.toBeNull()
    expect(byTest('add-account-overlay')!.className).toContain('z-[110]')
    expect(pa.beginSetup).toHaveBeenCalledWith({ providerId: 'codex', method: 'device' })
    expect(pa.signIn).toHaveBeenCalledWith({ accountId: 'acc-new', method: 'device' })
    expect(byTest('add-account-step-signing-in')).not.toBeNull()
  })

  it('the API key method opens the dialog at the key step', async () => {
    await render(snap({}))
    await click('codex-setup-method-apiKey')
    expect(pa.beginSetup).toHaveBeenCalledWith({ providerId: 'codex', method: 'apiKey' })
    expect(byTest('add-account-step-key')).not.toBeNull()
    expect(pa.signIn).not.toHaveBeenCalled()
  })
})

describe("this computer's Codex sign-in", () => {
  // After the choice (the assistants page, or Yes on the one-time question
  // after an update) main has Codex on, and nothing recorded.
  // Main names the folder: ~/.codex, with no CODEX_HOME set.
  const afterChoice = { externalDefaults: [{ providerId: 'codex' as const, home: '~/.codex' }] }
  const marked = (marker: Record<string, unknown>) => ({ externalDefaults: [{ providerId: 'codex' as const, home: '~/.codex', marker: { at: 1, ...marker } as any }] })
  // The record main keeps while its own check (or an adoption) of the folder runs.
  const reservation = { accountId: 'acc-probe', providerId: 'codex' as const, method: 'external' as const, state: 'pending' as const, external: true, createdAt: 1, signingIn: false }
  // As main registers this computer's sign-in: realm-only and unverified, and
  // with no provider label (main never sets one for a Codex account).
  const localAccount = account({ id: 'acc-local', providerId: 'codex', identityId: 'id-ext', external: true, unverified: true, authMethod: 'external', identityAssurance: 'realm-only' })

  it('nothing recorded: the page asks once, read-only, and offers canvas F2 d as signed in; nothing is registered', async () => {
    await render(snap({}, afterChoice))
    expect(pa.probeExternal).toHaveBeenCalledTimes(1)
    expect(pa.probeExternal).toHaveBeenCalledWith('codex')
    expect(byTest('codex-setup-adopt')).not.toBeNull()
    expect(byTest('codex-setup-found')!.textContent).toBe(`${CHECK}Codex 0.155.1 found`)
    // Claimed signed in only because Codex said so just now.
    expect(byTest('codex-setup-adopt-callout')!.textContent).toBe('iCodex is already signed in on this computer (~/.codex)')
    expect(byTest('codex-setup-use-existing')!.textContent).toContain('Use this sign-in')
    expect(byTest('codex-setup-use-existing')!.textContent).toContain('You confirm it at each launch, and it cannot run code reviews')
    const add = byTest('codex-setup-add-new')!
    expect(add.textContent).toContain('Add a new Codex account')
    expect(add.textContent).toContain('Recommended')
    expect(add.textContent).toContain('Its own sign-in folder; can be your reviewer')
    expect(byTest('codex-setup-skip')!.textContent).toContain('Skip for now')
    // No adoption, no yes recorded on the user's behalf.
    expect(pa.adoptExternal).not.toHaveBeenCalled()
    expect(pa.setEnabled).not.toHaveBeenCalled()
  })

  it('under StrictMode (development) too: the check runs once, and nothing is taken in', async () => {
    useProviderAccountsStore.setState({ snapshot: snap({}, afterChoice), loaded: true })
    await act(async () => {
      root.render(<React.StrictMode><CodexSetupStep onNext={onNext} onBack={onBack} stepAside={stepAside} returns={0} /></React.StrictMode>)
    })
    await flush()
    expect(pa.probeExternal).toHaveBeenCalledTimes(1)
    expect(pa.adoptExternal).not.toHaveBeenCalled()
    expect(byTest('codex-setup-adopt')).not.toBeNull()
  })

  it('while the check runs, says so, and offers nothing yet', async () => {
    pa.probeExternal.mockImplementationOnce(() => new Promise(() => {}))
    await render(snap({}, afterChoice))
    expect(byTest('codex-setup-this-computer-check')!.textContent).toContain("Checking this computer's Codex sign-in...")
    expect(byTest('codex-setup-adopt')).toBeNull()
    expect(byTest('codex-setup-sign-in')).toBeNull()
  })

  it('the check finds it signed out: the new-account sign-in, saying so; asking again is the same read-only check, never an adoption', async () => {
    pa.probeExternal.mockResolvedValueOnce({ ok: true, state: 'signed-out' })
    await render(snap({}, afterChoice))
    expect(byTest('codex-setup-use-existing')).toBeNull()
    expect(byTest('codex-setup-method-browser')).not.toBeNull()
    expect(byTest('codex-setup-adoption-note')!.textContent).toBe("This computer's Codex sign-in (~/.codex) is signed out.")
    expect(byTest('codex-setup-check-this-computer')!.textContent).toBe("Check this computer's sign-in again")
    // Signed in since: asked again, it is offered as signed in, and nothing is taken in.
    await click('codex-setup-check-this-computer')
    expect(pa.probeExternal).toHaveBeenCalledTimes(2)
    expect(pa.adoptExternal).not.toHaveBeenCalled()
    expect(byTest('codex-setup-adopt-callout')!.textContent).toBe('iCodex is already signed in on this computer (~/.codex)')
  })

  it('names the folder the check used: the one CODEX_HOME named, when it did', async () => {
    const elsewhere = { externalDefaults: [{ providerId: 'codex' as const, home: '~/codex-alt' }] }
    pa.probeExternal.mockResolvedValueOnce({ ok: true, state: 'signed-out' })
    await render(snap({}, elsewhere))
    expect(byTest('codex-setup-adoption-note')!.textContent).toBe("This computer's Codex sign-in (~/codex-alt) is signed out.")
    act(() => { root.unmount() })
    root = createRoot(container)
    await render(snap({}, elsewhere))
    expect(byTest('codex-setup-adopt-callout')!.textContent).toBe('iCodex is already signed in on this computer (~/codex-alt)')
    act(() => { root.unmount() })
    root = createRoot(container)
    pa.probeExternal.mockResolvedValueOnce({ ok: false, code: 'timed-out', message: 'x' })
    await render(snap({}, elsewhere))
    expect(byTest('codex-setup-adopt-callout')!.textContent).toBe('iThe app could not check whether Codex is signed in on this computer (~/codex-alt). Use this sign-in checks it again.')
  })

  it('walk fix W6: main names no folder (a CODEX_HOME it cannot use): the page names none, never a guessed ~/.codex', async () => {
    const unnamed = { externalDefaults: [{ providerId: 'codex' as const }] }
    pa.probeExternal.mockResolvedValueOnce({ ok: true, state: 'signed-out' })
    await render(snap({}, unnamed))
    expect(byTest('codex-setup-adoption-note')!.textContent).toBe("This computer's Codex sign-in is signed out.")
    act(() => { root.unmount() })
    root = createRoot(container)
    await render(snap({}, unnamed))
    expect(byTest('codex-setup-adopt-callout')!.textContent).toBe('iCodex is already signed in on this computer')
    act(() => { root.unmount() })
    root = createRoot(container)
    pa.probeExternal.mockResolvedValueOnce({ ok: false, code: 'timed-out', message: 'x' })
    await render(snap({}, unnamed))
    expect(byTest('codex-setup-adopt-callout')!.textContent).toBe('iThe app could not check whether Codex is signed in on this computer. Use this sign-in checks it again.')
    expect(container.textContent).not.toContain('~/.codex')
  })

  it('asked again and still signed out: says so, the way to ask again stays, and nothing is taken in', async () => {
    pa.probeExternal.mockResolvedValue({ ok: true, state: 'signed-out' })
    await render(snap({}, afterChoice))
    await click('codex-setup-check-this-computer')
    expect(pa.probeExternal).toHaveBeenCalledTimes(2)
    expect(byTest('codex-setup-adoption-note')!.textContent).toBe("This computer's Codex sign-in (~/.codex) is signed out.")
    expect(byTest('codex-setup-check-this-computer')).not.toBeNull()
    expect(pa.adoptExternal).not.toHaveBeenCalled()
  })

  it('no Codex sign-in folder on this computer: the new-account sign-in alone, nothing offered', async () => {
    pa.probeExternal.mockResolvedValueOnce({ ok: false, code: 'realm-unavailable', message: 'x' })
    await render(snap({}, afterChoice))
    expect(byTest('codex-setup-sign-in')).not.toBeNull()
    expect(byTest('codex-setup-use-existing')).toBeNull()
    expect(byTest('codex-setup-adoption-note')).toBeNull()
    expect(byTest('codex-setup-check-this-computer')).toBeNull()
  })

  it('no answer from the check: offered without claiming it is signed in', async () => {
    pa.probeExternal.mockResolvedValueOnce({ ok: false, code: 'timed-out', message: 'Codex did not answer in time.' })
    await render(snap({}, afterChoice))
    expect(byTest('codex-setup-adopt-callout')!.textContent).toBe('iThe app could not check whether Codex is signed in on this computer (~/.codex). Use this sign-in checks it again.')
    expect(byTest('codex-setup-use-existing')).not.toBeNull()
    expect(byTest('codex-setup-error')).toBeNull()
  })

  it('no check once a Codex account is signed in, or while a setup of this computer\'s sign-in stands', async () => {
    const work = account({ id: 'acc-work', providerId: 'codex', identityId: 'id-work', isProviderDefault: true })
    await render(snap({}, { ...afterChoice, accounts: [claudeMain, work] }))
    expect(byTest('codex-setup-done')).not.toBeNull()
    act(() => { root.unmount() })
    root = createRoot(container)
    await render(snap({}, { ...afterChoice, pendingSetups: [reservation] }))
    expect(pa.probeExternal).not.toHaveBeenCalled()
    expect(byTest('codex-setup-use-existing')).toBeNull()
  })

  it('unmounted while the check runs: nothing is shown or taken in after, and the page shown again asks afresh', async () => {
    let answer: (v: { ok: boolean; state?: string }) => void = () => {}
    pa.probeExternal.mockImplementationOnce(() => new Promise((r) => { answer = r }) as never)
    await render(snap({}, afterChoice))
    expect(byTest('codex-setup-checking-this-computer')).not.toBeNull()
    act(() => { root.unmount() })
    await act(async () => { answer({ ok: true, state: 'signed-in' }) })
    await flush()
    expect(byTest('codex-setup')).toBeNull()
    expect(pa.adoptExternal).not.toHaveBeenCalled()
    root = createRoot(container)
    await render(snap({}, afterChoice))
    expect(pa.probeExternal).toHaveBeenCalledTimes(2)
    expect(byTest('codex-setup-adopt')).not.toBeNull()
  })

  it('the record main pushes while its check runs keeps the page on "checking" (never "in use"), and nothing asks twice', async () => {
    let answer: (v: { ok: boolean; state?: string }) => void = () => {}
    pa.probeExternal.mockImplementationOnce(() => new Promise((r) => { answer = r }) as never)
    await render(snap({}, afterChoice))
    await act(async () => { useProviderAccountsStore.setState({ snapshot: snap({}, { ...afterChoice, revision: 2, pendingSetups: [reservation] }) }) })
    await flush()
    expect(byTest('codex-setup-this-computer-check')).not.toBeNull()
    expect(byTest('codex-setup-sign-in')).toBeNull()
    expect(byTest('codex-setup-adopt')).toBeNull()
    // The check answers, and the snapshot fetched after it no longer carries the record.
    pa.snapshot.mockResolvedValueOnce(snap({}, { ...afterChoice, revision: 3 }))
    await act(async () => { answer({ ok: true, state: 'signed-in' }) })
    await flush()
    expect(byTest('codex-setup-adopt-callout')!.textContent).toBe('iCodex is already signed in on this computer (~/.codex)')
    expect(pa.probeExternal).toHaveBeenCalledTimes(1)
  })

  it('with the CLI not found at first, the check runs once the CLI is found, and only once', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }, afterChoice))
    expect(pa.probeExternal).not.toHaveBeenCalled()
    // Installed since: the return from the terminal checks the CLI again.
    pa.discover.mockResolvedValue({ ok: true, installation: codex({ discoveryState: 'found', version: '0.155.1', compatibility: 'supported', lastCheckedAt: 2 }) })
    await act(async () => { root.render(<CodexSetupStep onNext={onNext} onBack={onBack} stepAside={stepAside} returns={1} />) })
    await flush()
    expect(pa.probeExternal).toHaveBeenCalledTimes(1)
    expect(byTest('codex-setup-adopt')).not.toBeNull()
    await act(async () => { root.render(<CodexSetupStep onNext={onNext} onBack={onBack} stepAside={stepAside} returns={2} />) })
    await flush()
    expect(pa.probeExternal).toHaveBeenCalledTimes(1)
  })

  it('not offered while the CLI is missing, with Codex off, or while the user has not said they use Codex', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }, afterChoice))
    expect(byTest('codex-setup-adopt')).toBeNull()
    act(() => { root.unmount() })
    root = createRoot(container)
    await render(snap({ enabled: false }, afterChoice))
    expect(byTest('codex-setup-use-existing')).toBeNull()
    act(() => { root.unmount() })
    root = createRoot(container)
    await render(snap({ preference: 'undecided' }, afterChoice))
    expect(byTest('codex-setup-use-existing')).toBeNull()
    expect(pa.adoptExternal).not.toHaveBeenCalled()
    // Nor is it checked: that would run the Codex CLI.
    expect(pa.probeExternal).not.toHaveBeenCalled()
  })

  it('"Use this sign-in" takes it in explicitly: main asks its status, registers it, and the page lands on the settled F2 d', async () => {
    let answer: (v: { ok: boolean; accountId?: string }) => void = () => {}
    pa.adoptExternal.mockImplementationOnce(() => new Promise((r) => { answer = r }) as never)
    await render(snap({}, afterChoice))
    await click('codex-setup-use-existing')
    expect(pa.adoptExternal).toHaveBeenCalledTimes(1)
    expect(pa.adoptExternal).toHaveBeenCalledWith('codex')
    expect(byTest('codex-setup-use-existing')!.textContent).toContain('Checking this sign-in...')
    // Main registered it: the snapshot it pushes carries the account.
    await act(async () => {
      answer({ ok: true, accountId: 'acc-local' })
      useProviderAccountsStore.setState({ snapshot: snap({}, { revision: 2, accounts: [claudeMain, localAccount], ...marked({ outcome: 'registered' }) }) })
    })
    await flush()
    expect(byTest('codex-setup-done')).not.toBeNull()
    expect(byTest('codex-setup-adopt-callout')!.textContent).toBe('iCodex is already signed in on this computer (~/.codex)')
    const shared = byTest('codex-setup-signed-in-acc-local')!
    expect(shared.textContent).toContain('Using this sign-in')
    expect(shared.textContent).toContain('You confirm it at each launch, and it cannot run code reviews')
    expect(byTest('codex-setup-add-new')!.textContent).toContain('Recommended')
    expect(byTest('codex-setup-use-existing')).toBeNull()
    await click('codex-setup-next')
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('found signed out when the user asked: the new-account sign-in, saying so, and a way to ask again', async () => {
    pa.adoptExternal.mockResolvedValueOnce({ ok: false, code: 'not-signed-in', message: 'Your existing sign-in is signed out; sign in to add an account.' } as any)
    await render(snap({}, afterChoice))
    await click('codex-setup-use-existing')
    expect(byTest('codex-setup-adopt')).toBeNull()
    expect(byTest('codex-setup-sign-in')).not.toBeNull()
    expect(byTest('codex-setup-method-browser')).not.toBeNull()
    expect(byTest('codex-setup-adoption-note')!.textContent).toBe("This computer's Codex sign-in (~/.codex) is signed out.")
    expect(byTest('codex-setup-check-this-computer')!.textContent).toBe("Check this computer's sign-in again")
    await click('codex-setup-check-this-computer')
    expect(pa.adoptExternal).toHaveBeenCalledTimes(2)
  })

  it('an explicit attempt that could not finish says why, and the offer stays to try again', async () => {
    pa.adoptExternal.mockResolvedValueOnce({ ok: false, code: 'timed-out', message: 'Codex did not answer in time.' } as any)
    await render(snap({}, afterChoice))
    await click('codex-setup-use-existing')
    expect(byTest('codex-setup-error')!.textContent).toBe('Codex did not answer in time.')
    expect(byTest('codex-setup-use-existing')).not.toBeNull()
    await click('codex-setup-use-existing')
    expect(pa.adoptExternal).toHaveBeenCalledTimes(2)
  })

  it('an earlier answer (the user\'s own adoption, its account archived since) is not trusted: the page asks Codex again', async () => {
    pa.probeExternal.mockResolvedValueOnce({ ok: true, state: 'signed-out' })
    await render(snap({}, marked({ outcome: 'registered' })))
    expect(pa.probeExternal).toHaveBeenCalledTimes(1)
    // Signed out since: never "already signed in".
    expect(byTest('codex-setup-adopt-callout')).toBeNull()
    expect(byTest('codex-setup-use-existing')).toBeNull()
    expect(byTest('codex-setup-adoption-note')!.textContent).toBe("This computer's Codex sign-in (~/.codex) is signed out.")
    act(() => { root.unmount() })
    root = createRoot(container)
    await render(snap({}, marked({ outcome: 'registered' })))
    expect(pa.probeExternal).toHaveBeenCalledTimes(2)
    expect(byTest('codex-setup-adopt-callout')!.textContent).toBe('iCodex is already signed in on this computer (~/.codex)')
    expect(byTest('codex-setup-add-new')!.textContent).toContain('Recommended')
    await click('codex-setup-use-existing')
    expect(pa.adoptExternal).toHaveBeenCalledWith('codex')
  })

  it('Add a new Codex account opens the add-account dialog at its methods, and never adopts', async () => {
    await render(snap({}, afterChoice))
    await click('codex-setup-add-new')
    expect(byTest('add-account-step-method')).not.toBeNull()
    expect(pa.beginSetup).not.toHaveBeenCalled()
    expect(pa.adoptExternal).not.toHaveBeenCalled()
  })

  // Only a development build's start-up check could record these: the page
  // never shows them, and asks Codex itself.
  for (const marker of [{ outcome: 'none' }, { outcome: 'skipped', reason: 'home-missing' }, { outcome: 'skipped', reason: 'no-cli' }, { outcome: 'skipped', reason: 'unavailable' }, { outcome: 'skipped', reason: 'overlap' }]) {
    it(`an answer a development build recorded (${Object.values(marker).join(', ')}): the page asks Codex itself, and adopts nothing`, async () => {
      await render(snap({}, marked(marker)))
      expect(pa.probeExternal).toHaveBeenCalledTimes(1)
      expect(byTest('codex-setup-adopt-callout')!.textContent).toBe('iCodex is already signed in on this computer (~/.codex)')
      expect(byTest('codex-setup-adoption-note')).toBeNull()
      expect(pa.adoptExternal).not.toHaveBeenCalled()
    })
  }

  it('a folder that overlaps the app\'s own, or cannot be checked: main\'s own reason and what to do, nothing offered, and no way to check again', async () => {
    // Walk fix N1: main answers the same code for a relative or doubly set
    // CODEX_HOME ("cannot be checked"), so the page says main's words, never
    // a narrower "overlaps" of its own.
    const main = "Your own Codex folder setting (CODEX_HOME, else ~/.codex) overlaps the app's Codex account folders, or cannot be checked. Set CODEX_HOME to a full path outside the app's data folder, or unset it, then try again."
    pa.probeExternal.mockResolvedValueOnce({ ok: false, code: 'external-overlap', message: main })
    await render(snap({}, afterChoice))
    expect(byTest('codex-setup-sign-in')).not.toBeNull()
    expect(byTest('codex-setup-use-existing')).toBeNull()
    expect(byTest('codex-setup-adoption-note')!.textContent).toBe(main)
    expect(byTest('codex-setup-check-this-computer')).toBeNull()
  })

  for (const code of ['capability-disabled', 'provider-disabled', 'provider-not-set-up', 'provider-state-unknown', 'unsupported']) {
    it(`a check Codex cannot run or use here (${code}): nothing offered, only the new-account sign-in`, async () => {
      pa.probeExternal.mockResolvedValueOnce({ ok: false, code, message: 'x' })
      await render(snap({}, afterChoice))
      expect(byTest('codex-setup-sign-in')).not.toBeNull()
      expect(byTest('codex-setup-method-browser')).not.toBeNull()
      expect(byTest('codex-setup-use-existing')).toBeNull()
      expect(byTest('codex-setup-adoption-note')).toBeNull()
      expect(byTest('codex-setup-check-this-computer')).toBeNull()
    })
  }
})

describe('signed in', () => {
  it('shows it done, and Next continues', async () => {
    const work = account({ id: 'acc-work', providerId: 'codex', identityId: 'id-work', providerLabel: 'alex@work.example', isProviderDefault: true })
    await render(snap({}, { accounts: [claudeMain, work] }))
    expect(byTest('codex-setup-done')).not.toBeNull()
    expect(byTest('codex-setup-signed-in-acc-work')!.textContent).toBe(`${CHECK}Signed in: Work`)
    expect(byTest('codex-setup-skip')).toBeNull()
    expect(byTest('codex-setup-add-new')).toBeNull()
    await click('codex-setup-next')
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it("only this computer's shared sign-in: done, and a new account is still recommended", async () => {
    const local = account({ id: 'acc-local', providerId: 'codex', identityId: 'id-ext', external: true, unverified: true, authMethod: 'external', identityAssurance: 'realm-only' })
    await render(snap({}, { accounts: [claudeMain, local] }))
    expect(byTest('codex-setup-done')).not.toBeNull()
    expect(byTest('codex-setup-signed-in-acc-local')!.textContent).toContain('You confirm it at each launch, and it cannot run code reviews')
    expect(byTest('codex-setup-add-new')!.textContent).toContain('Recommended')
    expect(byTest('codex-setup-next')).not.toBeNull()
  })

  it('a signed-out account is not done', async () => {
    const gone = account({ id: 'acc-out', providerId: 'codex', identityId: 'id-work', lastKnownAuthState: 'signed-out' })
    await render(snap({}, { accounts: [claudeMain, gone] }))
    expect(byTest('codex-setup-done')).toBeNull()
    expect(byTest('codex-setup-skip')).not.toBeNull()
  })
})

describe('no account list', () => {
  it('says so, once, and can be skipped', async () => {
    pa.discover.mockResolvedValue({ ok: false, code: 'registry-unavailable', message: 'The account list is not available right now.' })
    await render(null)
    expect(byTest('codex-setup-unavailable')).not.toBeNull()
    expect(byTest('codex-setup-error')).toBeNull()
    expect(container.textContent!.split('The account list is not available right now.').length - 1).toBe(1)
    await click('codex-setup-skip')
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('any other failure of the check is still shown', async () => {
    pa.discover.mockResolvedValue({ ok: false, code: 'internal', message: 'That did not work; try again.' })
    await render(null)
    expect(byTest('codex-setup-error')!.textContent).toBe('That did not work; try again.')
  })
})

describe('no command known', () => {
  it('names the list it is about: install, or update', async () => {
    pa.installRecipes.mockResolvedValue([])
    await render(snap({ discoveryState: 'found', version: '0.150.2', compatibility: 'too-old' }))
    expect(byTest('codex-recipes-none')!.textContent).toBe('No update command is known for this computer.')
    act(() => { root.unmount() })
    root = createRoot(container)
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(byTest('codex-recipes-none')!.textContent).toBe('No install command is known for this computer.')
  })

  it('and when the commands could not be read', async () => {
    pa.installRecipes.mockResolvedValue(null as any)
    await render(snap({ discoveryState: 'found', version: '0.150.2', compatibility: 'too-old' }))
    expect(byTest('codex-recipes-none')!.textContent).toBe('The update commands could not be read.')
  })
})

const CHECK = String.fromCodePoint(0x2713)
