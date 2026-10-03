// @vitest-environment jsdom
/**
 * "Do you use Codex?", the one-time page after an update (owner decisions
 * 2026-09-26; approved mockup .ccc-canvas/upgrade-codex-confirm.html,
 * screen 1): the REAL page, the REAL stores and the REAL save path, with only
 * main's providerAccounts IPC and the config save mocked.
 *
 * Verifies:
 *   - it renders the approved copy verbatim, the real Codex logo (the app's
 *     ProviderMark, never a coloured square), no close button, and Continue
 *     has focus;
 *   - Yes: main switches Codex on first, then the saved setting records it
 *     AND the answer (codexAnswered); No: the same, off; an answer main
 *     refuses is said and records nothing; with no account list the answer
 *     is saved on its own, so the page is never stuck;
 *   - with Claude Code off (a Codex-only install), No cannot be chosen, by
 *     click or by arrow key, and the page says why once;
 *   - Escape does nothing: nothing is saved, the page stays, and nothing
 *     behind the page hears it;
 *   - adding a Codex account while Codex is unanswered records the yes
 *     (on, and answered) before the account is set up, and never adopts the
 *     sign-in already on this computer; once answered it records nothing;
 *   - App: the gate is decided at boot, rendered on its turn, covers the app,
 *     and a Yes hands the user to the Codex setup page.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { provider, snapshot, claudeMain } from './accounts-snapshot-harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: vi.fn(() => Promise.resolve(true)),
  saveConfigDebounced: vi.fn(),
  flushPendingConfigSaves: vi.fn(() => Promise.resolve()),
  retryFailedConfigSaves: vi.fn(() => Promise.resolve()),
}))

const ok = () => Promise.resolve({ ok: true })
const pa = {
  snapshot: vi.fn(async () => null),
  onChanged: vi.fn(() => () => {}),
  setEnabled: vi.fn<(id: string, on: boolean) => Promise<Record<string, unknown>>>(ok),
  discover: vi.fn(ok),
  installRecipes: vi.fn(async () => []),
  adoptExternal: vi.fn(ok),
  probeExternal: vi.fn(ok),
  beginSetup: vi.fn(async () => ({ ok: true, accountId: 'acc-new' })),
  signIn: vi.fn(() => new Promise(() => {})),
  onSignInOutput: vi.fn(() => () => {}),
  cancelSignIn: vi.fn(ok),
  abandonSetup: vi.fn(ok),
  completeSetup: vi.fn(),
  issueSecretHandle: vi.fn(),
  sendSecret: vi.fn(),
}
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, providerAccounts: pa }
;(globalThis as any).window.electronPlatform = 'win32'

const { CodexReconfirmPage, NO_NEEDS_CLAUDE } = await import('../../../src/renderer/onboarding/CodexReconfirmPage')
const { AddProviderAccountDialog } = await import('../../../src/renderer/components/settings/accounts/AddProviderAccountDialog')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { codexSetUp } = await import('../../../src/renderer/onboarding/hello-codex')
const { default: APP_SOURCE } = await import('../../../src/renderer/App.tsx?raw')

let container: HTMLDivElement
let root: Root
const onAnswered = vi.fn()
const onShown = vi.fn()
const updateSpy = vi.fn()
const realUpdate = useSettingsStore.getState().updateSettings

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  ;(window as any).matchMedia = (q: string) => ({
    matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  })
  for (const f of Object.values(pa)) f.mockClear()
  pa.setEnabled.mockReset()
  pa.setEnabled.mockImplementation(ok)
  onAnswered.mockReset()
  onShown.mockReset()
  updateSpy.mockReset()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
  // Every save the page makes, in order, as the store receives it.
  useSettingsStore.setState({ updateSettings: (u) => { updateSpy(u); return realUpdate(u) } } as never)
  const unanswered = snapshot({ accounts: [claudeMain] })
  unanswered.providers[1] = { ...unanswered.providers[1], preference: 'undecided' }
  useProviderAccountsStore.setState({ snapshot: unanswered, loaded: true })
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

async function render() {
  await act(async () => { root.render(<CodexReconfirmPage onShown={onShown} onAnswered={onAnswered} />) })
  await flush()
}

async function click(id: string) {
  await act(async () => { byTest(id)!.click() })
  await flush()
}

describe('the page (screen 1 of the approved mockup)', () => {
  it('renders the approved copy, the real Codex logo, one Continue, no close button, and Continue has focus', async () => {
    await render()
    const page = container.querySelector('.ob-root')!
    expect(page.querySelector('.h2')!.textContent).toBe('Do you use Codex?')
    expect(page.querySelector('.p2-sub')!.textContent).toBe('Codex now has accounts of its own in this app. Choose again: your earlier Codex setting does not carry over.')
    const yes = byTest('codex-reconfirm-yes')!
    // P4.11 (row 54): no Beta label on the Codex card.
    expect(yes.querySelector('.as-t')!.textContent).toBe('Yes, set up Codex')
    expect(yes.querySelector('.as-beta')).toBeNull()
    expect(yes.querySelector('.as-sub')!.textContent).toBe('Use the Codex sign-in on this computer, or add a Codex account')
    // The app's own Codex mark (ProviderMark), drawn as Claude's is: an SVG glyph, not a coloured square.
    expect(yes.querySelector('.as-marks svg')).not.toBeNull()
    const no = byTest('codex-reconfirm-no')!
    expect(no.querySelector('.as-t')!.textContent).toBe("No, I don't use Codex")
    expect(no.querySelector('.as-sub')!.textContent).toBe('Codex stays off. You can set it up later in Settings, Accounts.')
    expect(byTest('codex-reconfirm-local-note')!.textContent).toBe('Codex sessions run on this computer only in this release.')
    const buttons = Array.from(page.querySelectorAll('button')).map((b) => b.textContent)
    expect(buttons.filter((t) => t === 'Continue')).toHaveLength(1)
    expect(page.querySelector('[aria-label="Close"], [data-testid$="-close"]')).toBeNull()
    expect(document.activeElement).toBe(byTest('codex-reconfirm-continue'))
    // Yes is chosen to start with, as in the mockup; nothing is saved by showing the page.
    expect(yes.getAttribute('aria-checked')).toBe('true')
    expect(no.getAttribute('aria-checked')).toBe('false')
    expect(onShown).toHaveBeenCalledTimes(1)
    expect(pa.setEnabled).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
  })

  it('Yes: main switches Codex on, then the setting records it and the answer, then the page is done', async () => {
    await render()
    await click('codex-reconfirm-continue')
    expect(pa.setEnabled).toHaveBeenCalledWith('codex', true)
    expect(updateSpy).toHaveBeenCalledWith({ codexEnabled: true, codexAnswered: true })
    expect(pa.setEnabled.mock.invocationCallOrder[0]).toBeLessThan(updateSpy.mock.invocationCallOrder[0])
    expect(useSettingsStore.getState().settings).toMatchObject({ codexEnabled: true, codexAnswered: true })
    expect(onAnswered).toHaveBeenCalledWith(true)
    // Claude Code is left as it was.
    expect(pa.setEnabled).not.toHaveBeenCalledWith('claude', expect.anything())
    expect(Object.hasOwn(useSettingsStore.getState().settings, 'claudeEnabled')).toBe(false)
  })

  it('No: main switches Codex off, then the setting records it and the answer', async () => {
    await render()
    await click('codex-reconfirm-no')
    expect(byTest('codex-reconfirm-no')!.getAttribute('aria-checked')).toBe('true')
    await click('codex-reconfirm-continue')
    expect(pa.setEnabled).toHaveBeenCalledWith('codex', false)
    expect(updateSpy).toHaveBeenCalledWith({ codexEnabled: false, codexAnswered: true })
    expect(onAnswered).toHaveBeenCalledWith(false)
  })

  it('an answer main refuses is said, records nothing, and the page stays to answer again', async () => {
    pa.setEnabled.mockResolvedValueOnce({ ok: false, code: 'consumers', consumers: 2, message: 'Sessions or operations are using this account.' })
    await render()
    await click('codex-reconfirm-no')
    await click('codex-reconfirm-continue')
    expect(byTest('codex-reconfirm-error')!.textContent).toBe('Codex is in use right now (2). Close what is using it, then choose again.')
    expect(updateSpy).not.toHaveBeenCalled()
    expect(onAnswered).not.toHaveBeenCalled()
    await click('codex-reconfirm-continue')
    expect(onAnswered).toHaveBeenCalledWith(false)
  })

  it('with no account list yet, the answer is saved on its own, so the page is never stuck', async () => {
    pa.setEnabled.mockResolvedValueOnce({ ok: false, code: 'registry-unavailable', message: 'The account list is not available right now.' })
    await render()
    await click('codex-reconfirm-continue')
    expect(updateSpy).toHaveBeenCalledWith({ codexEnabled: true, codexAnswered: true })
    expect(onAnswered).toHaveBeenCalledWith(true)
  })

  it('the arrow keys move the choice between the two cards', async () => {
    await render()
    const group = byTest('codex-reconfirm-cards')!
    await act(async () => { group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
    expect(byTest('codex-reconfirm-no')!.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(byTest('codex-reconfirm-no'))
    await act(async () => { group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })) })
    expect(byTest('codex-reconfirm-yes')!.getAttribute('aria-checked')).toBe('true')
  })
})

describe('Claude Code off (a Codex-only install): No cannot be chosen', () => {
  for (const [what, setOff] of [
    ['the saved setting says so', () => useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false } })],
    ['main says so', () => {
      const s = useProviderAccountsStore.getState().snapshot!
      useProviderAccountsStore.setState({ snapshot: { ...s, providers: [{ ...s.providers[0], enabled: false, preference: 'off' }, s.providers[1]] } })
    }],
  ] as const) {
    it(`${what}: No is disabled, says why once, and cannot be reached by click or arrow key`, async () => {
      setOff()
      await render()
      const no = byTest('codex-reconfirm-no') as HTMLButtonElement
      expect(no.disabled).toBe(true)
      expect(byTest('codex-reconfirm-no-why')!.textContent).toBe(NO_NEEDS_CLAUDE)
      expect(container.textContent!.split(NO_NEEDS_CLAUDE).length - 1).toBe(1)
      await click('codex-reconfirm-no')
      await act(async () => { byTest('codex-reconfirm-cards')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
      expect(byTest('codex-reconfirm-yes')!.getAttribute('aria-checked')).toBe('true')
      await click('codex-reconfirm-continue')
      expect(pa.setEnabled).toHaveBeenCalledWith('codex', true)
      expect(pa.setEnabled).not.toHaveBeenCalledWith('codex', false)
      expect(onAnswered).toHaveBeenCalledWith(true)
    })
  }
})

describe('it cannot be left without answering', () => {
  it('Escape does nothing: nothing is saved, the page stays, and nothing behind it hears the key', async () => {
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    try {
      await render()
      const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      await act(async () => { document.body.dispatchEvent(ev) })
      await act(async () => { byTest('codex-reconfirm-continue')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
      await flush()
      expect(ev.defaultPrevented).toBe(true)
      expect(behind).not.toHaveBeenCalled()
      expect(byTest('codex-reconfirm')).not.toBeNull()
      expect(onAnswered).not.toHaveBeenCalled()
      expect(pa.setEnabled).not.toHaveBeenCalled()
      expect(updateSpy).not.toHaveBeenCalled()
      // Any other key is left alone.
      await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })) })
      expect(behind).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', behind)
    }
  })

  it('once it is gone, Escape reaches the app again', async () => {
    const behind = vi.fn()
    window.addEventListener('keydown', behind)
    try {
      await render()
      act(() => { root.unmount() })
      root = createRoot(container)
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(behind).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', behind)
    }
  })
})

describe('adding a Codex account is a yes (E), and never adopts', () => {
  const codexView = () => useProviderAccountsStore.getState().snapshot!.providers[1]

  async function openAdd() {
    await act(async () => { root.render(<AddProviderAccountDialog provider={codexView()} onClose={vi.fn()} />) })
    await flush()
  }

  it('unanswered: choosing a method records Codex on and answered first, then sets the account up', async () => {
    await openAdd()
    await click('add-account-method-browser')
    expect(pa.setEnabled).toHaveBeenCalledWith('codex', true)
    expect(updateSpy).toHaveBeenCalledWith({ codexEnabled: true, codexAnswered: true })
    expect(pa.beginSetup).toHaveBeenCalledWith({ providerId: 'codex', method: 'browser' })
    expect(pa.setEnabled.mock.invocationCallOrder[0]).toBeLessThan(pa.beginSetup.mock.invocationCallOrder[0])
    expect(updateSpy.mock.invocationCallOrder[0]).toBeLessThan(pa.beginSetup.mock.invocationCallOrder[0])
    expect(pa.adoptExternal).not.toHaveBeenCalled()
    expect(pa.probeExternal).not.toHaveBeenCalled()
  })

  it('a yes that cannot be recorded stops there: nothing is set up, and the dialog says why', async () => {
    pa.setEnabled.mockResolvedValueOnce({ ok: false, code: 'persist-failed', message: 'The change could not be saved.' })
    await openAdd()
    await click('add-account-method-browser')
    expect(pa.beginSetup).not.toHaveBeenCalled()
    expect(byTest('add-account-dialog')!.textContent).toContain('The change could not be saved.')
  })

  it('already answered: nothing more is recorded', async () => {
    const s = useProviderAccountsStore.getState().snapshot!
    useProviderAccountsStore.setState({ snapshot: { ...s, providers: [s.providers[0], { ...s.providers[1], preference: 'on' }] } })
    await openAdd()
    await click('add-account-method-browser')
    expect(pa.setEnabled).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
    expect(pa.beginSetup).toHaveBeenCalledWith({ providerId: 'codex', method: 'browser' })
  })
})

describe('Hello Codex after the answer (F)', () => {
  const managed = { id: 'acc-work', providerId: 'codex' as const, identityId: 'id-work', lifecycle: 'active' as const, isProviderDefault: true, isReviewerDefault: false, authMethod: 'browser' as const, lastKnownAuthState: 'signed-in' as const, operationalState: 'ready' as const, identityAssurance: 'user-asserted' as const, realmLifecycle: 'active' as const, external: false, unverified: false, legacyLinked: false, runningSessions: 0, runningReviews: 0, consumers: 0 }
  const external = { ...managed, id: 'acc-local', external: true, unverified: true, authMethod: 'external' as const, identityAssurance: 'realm-only' as const }
  const withCodex = (preference: 'on' | 'undecided' | 'off', accounts: typeof managed[]) => snapshot({
    providers: [provider({ providerId: 'claude', displayName: 'Claude Code' }), provider({ providerId: 'codex', displayName: 'Codex', preference, enabled: preference !== 'off' })],
    accounts: [claudeMain, ...accounts],
  })

  it('after Yes (on) and a signed-in account added in the app: set up, so the introduction is due', () => {
    expect(codexSetUp(withCodex('on', [managed]))).toBe(true)
  })
  it('unanswered, even with such an account: not set up', () => {
    expect(codexSetUp(withCodex('undecided', [managed]))).toBe(false)
  })
  it('only the sign-in already on this computer: still excluded', () => {
    expect(codexSetUp(withCodex('on', [external]))).toBe(false)
  })
})

describe('App wiring', () => {
  const APP = (APP_SOURCE as string).replace(/\r\n/g, '\n')

  it('decides the gate at boot from the pre-stamp meta and the saved answer, and stamps nothing there', () => {
    const at = APP.indexOf('const reconfirm = decideCodexReconfirm({')
    expect(at).toBeGreaterThan(-1)
    const block = APP.slice(at, APP.indexOf('if (reconfirm.show) setCodexReconfirmArmed(true)', at))
    expect(block).toContain('answered: codexAnswered(useSettingsStore.getState().settings)')
    expect(block).toContain('lastSeenVersion: appMeta.lastSeenVersion')
    // Before this build's run is recorded, like the Multi Spawn decision.
    expect(at).toBeLessThan(APP.indexOf('useAppMetaStore.getState().update({ lastRunVersion: __APP_VERSION__ })'))
  })

  it('renders the page on its turn, covers the app, and a Yes hands over to the Codex setup page', () => {
    expect(APP).toContain('codexReconfirmDue: codexReconfirmDue({ armed: codexReconfirmArmed, shown: codexReconfirmShown, answered: codexAnsweredNow }),')
    expect(APP).toContain("|| bootGate === 'codexReconfirm' ||")
    const at = APP.indexOf("{bootGate === 'codexReconfirm' && (")
    expect(at).toBeGreaterThan(-1)
    const site = APP.slice(at, APP.indexOf('/>', APP.indexOf('<CodexReconfirmPage', at)) + 2)
    expect(site).toContain('onShown={() => setCodexReconfirmShown(true)}')
    expect(site).toMatch(/if \(usesCodex\) \{\s*noteCodexChosenOnUpgrade\(\)\s*setCodexSetupHandOff\(true\)\s*\}\s*setCodexReconfirmArmed\(false\)/)
  })
})

describe('the session dialog while Codex is not set up (B)', () => {
  const account = {
    available: true, value: '', options: [], noAccount: true, askAck: false, ackLabel: '', ackChecked: false,
    onChange: vi.fn(), onAckChange: vi.fn(),
  }

  async function renderFields(onOpenAccounts: () => void) {
    const { CodexFormFields } = await import('../../../src/renderer/components/SessionDialog/CodexFormFields')
    await act(async () => { root.render(<CodexFormFields value={{}} onChange={vi.fn()} onOpenAccounts={onOpenAccounts} account={account} />) })
    await flush()
  }

  it('says Codex is not set up, and its own words open Accounts, instead of asking for an account', async () => {
    const open = vi.fn()
    await renderFields(open)
    expect(byTest('codex-not-set-up')!.textContent).toBe('Codex is not set up yet. Open Accounts to set it up.')
    expect(byTest('codex-no-account')).toBeNull()
    await act(async () => { byTest('codex-not-set-up')!.querySelector('button')!.click() })
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('once answered, the usual missing-account notice', async () => {
    const s = useProviderAccountsStore.getState().snapshot!
    useProviderAccountsStore.setState({ snapshot: { ...s, providers: [s.providers[0], { ...s.providers[1], preference: 'on' }] } })
    await renderFields(vi.fn())
    expect(byTest('codex-not-set-up')).toBeNull()
    expect(byTest('codex-no-account')!.textContent).toBe('Sign in to Codex first. Open Accounts.')
  })
})
