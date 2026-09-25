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
 *   - this computer's sign-in (review fix, fixtures as main produces them
 *     after the assistants choice: Codex on, so `needsConfirmation` false):
 *     the page runs the one-time check itself, once, saying it is checking;
 *     a signed-in result lands on canvas F2 d settled; "Use this sign-in"
 *     only for a sign-in main found and no account stands for; every other
 *     answer is the sign-in choices with its reason as a note, and a way to
 *     check again where main can look again;
 *   - signed in: done, and Next continues (no Skip);
 *   - the no-registry state says so once; the update list says "update".
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

// Main's own recipes for Windows, as the IPC returns them (no argv): the line
// to type (`runLine`) only where main allows the recipe to run, built by main.
const RECIPES: InstallRecipeView[] = codexInstallRecipes('win32').map((r) => {
  const runLine = recipeRunLine(r, 'win32')
  return {
    id: r.id, providerId: r.providerId, purpose: r.purpose, publisher: r.publisher, sourceUrl: r.sourceUrl, displayCommand: r.displayCommand,
    method: r.method, needsNetwork: r.needsNetwork, mayElevate: r.mayElevate, autoRunAllowed: r.autoRunAllowed, ...(r.note !== undefined ? { note: r.note } : {}),
    ...(runLine !== undefined ? { runLine } : {}),
  }
})
const NPM_INSTALL = RECIPES.find((r) => r.id === 'codex-npm-install')!
const PS1 = RECIPES.find((r) => r.id === 'codex-script-install-ps1')!
const NPM_UPDATE = RECIPES.find((r) => r.id === 'codex-npm-update')!
// What Windows types: npm.cmd, not the npm.ps1 PowerShell's execution policy
// refuses to load. Not the command the user is shown.
const NPM_INSTALL_LINE = "npm.cmd 'install' '-g' '@openai/codex'"
const NPM_UPDATE_LINE = "npm.cmd 'install' '-g' '@openai/codex@latest'"

const ok = () => Promise.resolve({ ok: true })
const pa = {
  snapshot: vi.fn(),
  onChanged: vi.fn(() => () => {}),
  discover: vi.fn(),
  installRecipes: vi.fn(async () => RECIPES),
  runMigration: vi.fn<(id: string) => Promise<{ ok: boolean; outcome?: string; code?: string; message?: string }>>(),
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
  pa.runMigration.mockReset()
  pa.runMigration.mockResolvedValue({ ok: true, outcome: 'not-signed-in' })
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

  it('the recipe main sent a line for runs in a terminal and shows its note; the script (no line) is Copy only', async () => {
    expect(NPM_INSTALL.runLine).toBe(NPM_INSTALL_LINE)
    expect(PS1.runLine).toBeUndefined()
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(byTest(`codex-recipe-run-${NPM_INSTALL.id}`)!.textContent).toBe('Run in a terminal')
    expect(byTest(`codex-recipe-note-${NPM_INSTALL.id}`)!.textContent).toBe(NPM_INSTALL.note)
    expect(byTest(`codex-recipe-run-${PS1.id}`)).toBeNull()
    expect(byTest(`codex-recipe-copy-${PS1.id}`)!.textContent).toBe('Copy')
    expect(byTest(`codex-recipe-note-${PS1.id}`)!.textContent).toContain('Shown for you to review and run yourself; the app does not run it.')
  })

  it('whether a recipe runs is main\'s call: a package-manager recipe main sent no line for is Copy only', async () => {
    const { runLine: _dropped, ...noLine } = NPM_INSTALL
    pa.installRecipes.mockResolvedValue([noLine, PS1])
    await render(snap({ discoveryState: 'missing', version: undefined }))
    expect(noLine.method).toBe('package-manager')
    expect(noLine.autoRunAllowed).toBe(true)
    expect(byTest(`codex-recipe-run-${NPM_INSTALL.id}`)).toBeNull()
    expect(byTest(`codex-recipe-copy-${NPM_INSTALL.id}`)!.textContent).toBe('Copy')
    await click(`codex-recipe-copy-${NPM_INSTALL.id}`)
    // Copy is the shown command, verbatim.
    expect(writeText).toHaveBeenCalledWith(NPM_INSTALL.displayCommand)
    expect(useSessionStore.getState().sessions).toEqual([])
  })

  it('Copy puts the exact script command on the clipboard and runs nothing', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }))
    await click(`codex-recipe-copy-${PS1.id}`)
    expect(writeText).toHaveBeenCalledWith(PS1.displayCommand)
    expect(byTest(`codex-recipe-copy-${PS1.id}`)!.textContent).toBe('Copied')
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(stepAside).not.toHaveBeenCalled()
  })

  it('Run in a terminal asks first, showing the line it will type; Cancel runs nothing', async () => {
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
  // After the assistants choice main has Codex on, so it asks for nothing:
  // no marker yet, and `needsConfirmation` false.
  const afterChoice = { externalDefaults: [{ providerId: 'codex' as const, needsConfirmation: false }] }
  const marked = (marker: Record<string, unknown>) => ({ externalDefaults: [{ providerId: 'codex' as const, needsConfirmation: false, marker: { at: 1, ...marker } as any }] })
  // As main registers this computer's sign-in: realm-only and unverified, and
  // with no provider label (main never sets one for a Codex account).
  const localAccount = account({ id: 'acc-local', providerId: 'codex', identityId: 'id-ext', external: true, unverified: true, authMethod: 'external', identityAssurance: 'realm-only' })

  it('after the choice, with nothing recorded, the page runs the check itself, once, and says it is checking', async () => {
    let answer: (v: { ok: boolean; outcome?: string }) => void = () => {}
    pa.runMigration.mockImplementationOnce(() => new Promise((r) => { answer = r }))
    await render(snap({}, afterChoice))
    expect(pa.runMigration).toHaveBeenCalledTimes(1)
    expect(pa.runMigration).toHaveBeenCalledWith('codex')
    expect(byTest('codex-setup-this-computer-check')!.textContent).toBe("!Checking this computer's Codex sign-in...")
    // No flash of the sign-in choices while it runs.
    expect(byTest('codex-setup-sign-in')).toBeNull()
    expect(byTest('codex-setup-method-browser')).toBeNull()
    await act(async () => { answer({ ok: true, outcome: 'not-signed-in' }) })
    await flush()
    // Asked once, whatever the page renders next.
    await act(async () => { root.render(<CodexSetupStep onNext={onNext} onBack={onBack} stepAside={stepAside} returns={1} />) })
    await flush()
    expect(pa.runMigration).toHaveBeenCalledTimes(1)
  })

  it('not while the CLI is missing, nor with Codex off, nor once an answer is recorded', async () => {
    await render(snap({ discoveryState: 'missing', version: undefined }, afterChoice))
    act(() => { root.unmount() })
    root = createRoot(container)
    await render(snap({ enabled: false }, afterChoice))
    act(() => { root.unmount() })
    root = createRoot(container)
    await render(snap({}, marked({ outcome: 'none' })))
    expect(pa.runMigration).not.toHaveBeenCalled()
  })

  it("main still wanting the user's yes: the yes first, then the check (the Accounts surface's order)", async () => {
    pa.runMigration.mockResolvedValueOnce({ ok: true, outcome: 'needs-confirmation' }).mockResolvedValueOnce({ ok: true, outcome: 'not-signed-in' })
    await render(snap({}, { externalDefaults: [{ providerId: 'codex' as const, needsConfirmation: true }] }))
    expect(pa.runMigration).toHaveBeenCalledTimes(2)
    expect(pa.setEnabled).toHaveBeenCalledWith('codex', true)
    const [first, second] = pa.runMigration.mock.invocationCallOrder
    expect(first).toBeLessThan(pa.setEnabled.mock.invocationCallOrder[0])
    expect(pa.setEnabled.mock.invocationCallOrder[0]).toBeLessThan(second)
  })

  it('a signed-in result lands on the settled F2 d: in use, confirmed at each launch, a new account still Recommended, Next continues', async () => {
    const after = snap({}, { revision: 2, accounts: [claudeMain, localAccount], ...marked({ outcome: 'registered' }) })
    pa.runMigration.mockResolvedValueOnce({ ok: true, outcome: 'registered' })
    pa.snapshot.mockResolvedValue(after)
    await render(snap({}, afterChoice))
    expect(byTest('codex-setup-done')).not.toBeNull()
    expect(byTest('codex-setup-adopt-callout')!.textContent).toBe('iCodex is already signed in on this computer (~/.codex)')
    const shared = byTest('codex-setup-signed-in-acc-local')!
    expect(shared.textContent).toContain('Using this sign-in')
    expect(shared.textContent).toContain('You confirm it at each launch, and it cannot run code reviews')
    const add = byTest('codex-setup-add-new')!
    expect(add.textContent).toContain('Add a new Codex account')
    expect(add.textContent).toContain('Recommended')
    expect(add.textContent).toContain('Its own sign-in folder; can be your reviewer')
    // Nothing to use: it is in use.
    expect(byTest('codex-setup-use-existing')).toBeNull()
    expect(byTest('codex-setup-skip')).toBeNull()
    await click('codex-setup-next')
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('"Use this sign-in" only for a sign-in main found that no account stands for now', async () => {
    await render(snap({}, marked({ outcome: 'registered' })))
    expect(byTest('codex-setup-adopt-callout')!.textContent).toContain('Codex is already signed in on this computer (~/.codex)')
    expect(byTest('codex-setup-use-existing')!.textContent).toContain('Use this sign-in')
    expect(byTest('codex-setup-use-existing')!.textContent).toContain('You confirm it at each launch, and it cannot run code reviews')
    expect(byTest('codex-setup-add-new')!.textContent).toContain('Recommended')
    expect(byTest('codex-setup-sign-in')).toBeNull()
    await click('codex-setup-use-existing')
    expect(pa.adoptExternal).toHaveBeenCalledWith('codex')
  })

  it('Add a new Codex account opens the add-account dialog at its methods', async () => {
    await render(snap({}, marked({ outcome: 'registered' })))
    await click('codex-setup-add-new')
    expect(byTest('add-account-step-method')).not.toBeNull()
    expect(pa.beginSetup).not.toHaveBeenCalled()
  })

  const answers: Array<[string, Record<string, unknown>, string]> = [
    ['signed out', { outcome: 'none' }, "When the app first checked, this computer's Codex was signed out."],
    ['no ~/.codex', { outcome: 'skipped', reason: 'home-missing' }, 'There was no Codex sign-in folder (~/.codex) on this computer when the app first checked.'],
    ['no CLI', { outcome: 'skipped', reason: 'no-cli' }, 'The Codex CLI was not found when the app first checked.'],
    ['no answer in time', { outcome: 'skipped', reason: 'unavailable' }, "The app could not check this computer's Codex sign-in when it first tried: it timed out, did not start, or Codex was busy."],
  ]
  for (const [what, marker, note] of answers) {
    it(`${what}: the sign-in choices, the reason as a note, and a way to check again`, async () => {
      await render(snap({}, marked(marker)))
      expect(byTest('codex-setup-sign-in')).not.toBeNull()
      expect(byTest('codex-setup-method-browser')).not.toBeNull()
      expect(byTest('codex-setup-use-existing')).toBeNull()
      expect(byTest('codex-setup-adopt-callout')).toBeNull()
      expect(byTest('codex-setup-adoption-note')!.textContent).toBe(note)
      expect(byTest('codex-setup-check-this-computer')!.textContent).toBe("Check this computer's sign-in again")
      await click('codex-setup-check-this-computer')
      expect(pa.adoptExternal).toHaveBeenCalledWith('codex')
    })
  }

  it('checking again and still signed out: says what main said', async () => {
    pa.adoptExternal.mockResolvedValueOnce({ ok: false, code: 'not-signed-in', message: 'Your existing sign-in is signed out; sign in to add an account.' } as any)
    await render(snap({}, marked({ outcome: 'none' })))
    await click('codex-setup-check-this-computer')
    expect(byTest('codex-setup-error')!.textContent).toBe('Your existing sign-in is signed out; sign in to add an account.')
  })

  it('a folder that cannot be used here: the note, and no way to check again', async () => {
    await render(snap({}, marked({ outcome: 'skipped', reason: 'overlap' })))
    expect(byTest('codex-setup-adoption-note')!.textContent).toContain('overlaps')
    expect(byTest('codex-setup-check-this-computer')).toBeNull()
  })

  it('under StrictMode (development): the check runs once, and an answer that records nothing still reaches the sign-in choices', async () => {
    // retry-later: main answered but recorded no marker, so only the page's
    // own state moves it on; StrictMode's remount must not leave it stuck on
    // "Checking..." nor ask twice.
    pa.runMigration.mockResolvedValueOnce({ ok: true, outcome: 'retry-later' })
    useProviderAccountsStore.setState({ snapshot: snap({}, afterChoice), loaded: true })
    await act(async () => {
      root.render(<React.StrictMode><CodexSetupStep onNext={onNext} onBack={onBack} stepAside={stepAside} returns={0} /></React.StrictMode>)
    })
    await flush()
    expect(pa.runMigration).toHaveBeenCalledTimes(1)
    expect(byTest('codex-setup-this-computer-check')).toBeNull()
    expect(byTest('codex-setup-sign-in')).not.toBeNull()
    expect(byTest('codex-setup-method-browser')).not.toBeNull()
  })

  it('a check that got no answer: the sign-in choices, said plainly, and a way to check again', async () => {
    pa.runMigration.mockResolvedValueOnce({ ok: false, code: 'capability-disabled', message: 'x' })
    await render(snap({}, afterChoice))
    expect(byTest('codex-setup-sign-in')).not.toBeNull()
    expect(byTest('codex-setup-adoption-note')!.textContent).toBe("The app could not check this computer's Codex sign-in just now.")
    expect(byTest('codex-setup-check-this-computer')).not.toBeNull()
    expect(byTest('codex-setup-this-computer-check')).toBeNull()
  })
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
