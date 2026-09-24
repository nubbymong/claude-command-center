// @vitest-environment jsdom
// Acceptance criteria for Hello Codex, the Codex introduction (WP2 commit 6f):
// docs/wp2/hello-codex-spec.md, "Acceptance criteria". Written as pending
// cases before the page was built; commit 6f turned AC1-AC13 into real tests.
// AC14 belongs to commit 7 (the Feature Guide and app-knowledge guidance) and
// stays pending here until then. The last block holds the review round 1
// fixes: a Codex-only install, the close dialogs above the takeover, the
// arming delay, the global shortcuts, Back, and the resume prompt.
//
// Drives the REAL gate (hello-codex.ts), the REAL component and its takeover
// host (HelloCodex.tsx), the REAL onboarding harness with every other page a
// stand-in (as onboarding-provider-flow.test.tsx does), the REAL boot chain
// (bootChain, as App calls it), the REAL New saved config dialog, and the
// REAL replay links in the Feature Guide and Settings, Accounts. Plain
// createElement: this file kept the .ts name it was filed under.
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
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/utils/imageTransfer', () => ({ sendImageToSession: vi.fn() }))
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
  debug: { isEnabled: vi.fn().mockResolvedValue(false) },
  dialog: { openFolder: vi.fn().mockResolvedValue(null) },
  credentials: { save: vi.fn(), delete: vi.fn() },
}
;(globalThis as any).window.electronPlatform = 'win32'

const h = React.createElement
const {
  CLAUDE_REVIEW_SHIPS, HELLO_CODEX_ARM_MS, codexSetUp, claudeCodeOn, helloCodexDue, helloCodexPages, helloCodexComparison,
  helloCodexTakeoverReady, useHelloCodexStore, showHelloCodexReplay,
} = await import('../../../src/renderer/onboarding/hello-codex')
const { HelloCodex, HelloCodexStep, HelloCodexTakeover, HelloCodexHost, useHeldCodexSessionStart } = await import('../../../src/renderer/onboarding/HelloCodex')
const { OnboardingHarness } = await import('../../../src/renderer/onboarding/OnboardingHarness')
const { STEPS, ONBOARDING_VERSION } = await import('../../../src/renderer/onboarding/steps')
const { stepsNewSince, deriveOnboarding } = await import('../../../src/renderer/onboarding/gate')
const { pickBootGate, bootChain } = await import('../../../src/renderer/utils/bootGates')
const { useSettingsStore, DEFAULT_SETTINGS, DEFAULT_CONDUCTOR_TOOLS } = await import('../../../src/renderer/stores/settingsStore')
const { useAppMetaStore } = await import('../../../src/renderer/stores/appMetaStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { usePaneOcclusionStore } = await import('../../../src/renderer/stores/paneOcclusionStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { resetProviderChoiceForTests, noteClaudeMissingAtSetup } = await import('../../../src/renderer/onboarding/provider-choice')
const { useKeyboardShortcuts } = await import('../../../src/renderer/hooks/useKeyboardShortcuts')
const { DEFAULT_SHORTCUTS } = await import('../../../src/renderer/utils/shortcuts')
const { default: SessionDialog } = await import('../../../src/renderer/components/SessionDialog')
const { default: CloseDialog } = await import('../../../src/renderer/components/CloseDialog')
const { default: FeatureGuidePage } = await import('../../../src/renderer/components/FeatureGuidePage')
const { ProvidersCard } = await import('../../../src/renderer/components/settings/accounts/ProvidersCard')
const { snapshot, provider, account, work, local } = await import('./accounts-snapshot-harness')
type ProviderView = Parameters<typeof provider>[0]
type AccountRow = ReturnType<typeof account>

const ROOT = resolve(__dirname, '..', '..', '..')
const src = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')
const VERSION = '2.1.1-beta.1'

let container: HTMLDivElement
let root: Root
let reducedMotion = false

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  reducedMotion = false
  ;(window as any).matchMedia = (q: string) => ({
    matches: q.includes('reduced-motion') ? reducedMotion : false, media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  })
  resetProviderChoiceForTests()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
  useAppMetaStore.setState({ meta: {} })
  useProviderAccountsStore.setState({ snapshot: null, loaded: true })
  useHelloCodexStore.setState({ open: null })
  usePaneOcclusionStore.setState({ overlays: 0 })
  ;(globalThis as any).__APP_VERSION__ = VERSION
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
})

const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const click = async (id: string) => { await act(async () => { byTest(id)!.click() }) }
const key = async (k: string, init: KeyboardEventInit = {}) => {
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })) })
}
const heading = () => byTest('hc-heading')?.textContent ?? null
const seen = () => useAppMetaStore.getState().meta.helloCodexSeenVersion
const pageText = () => byTest('hc-page')?.textContent ?? ''
const pointsText = () => byTest('hc-points')?.textContent ?? ''
const remount = () => { act(() => { root.unmount() }); root = createRoot(container) }

/** A snapshot whose Codex installation and accounts are as given. */
function withCodex(over: Partial<ProviderView> = {}, accounts: AccountRow[] = [work], claude: Partial<ProviderView> = {}) {
  return snapshot({
    providers: [provider({ providerId: 'claude', displayName: 'Claude Code', ...claude }), provider({ providerId: 'codex', displayName: 'Codex', ...over })],
    accounts,
  })
}

async function render(el: React.ReactElement) {
  await act(async () => { root.render(el) })
}

/** Render the takeover (or anything holding it) and let its arming delay pass. */
async function renderArmed(el: React.ReactElement) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await render(el)
  await act(async () => { vi.advanceTimersByTime(HELLO_CODEX_ARM_MS) })
  vi.useRealTimers()
}

// App's wiring, through the same bootChain App calls: the host's two
// answers come from it, and the takeover renders on its own turn.
const BASE = {
  configLoaded: true, logsWipeBytes: 0, showTraining: false, showTrainingAll: false, showGitHubOnboarding: false,
  loggingConsentSeen: true, whatsNewDue: false, trainingDue: false, githubOnboardingDue: false,
}
function AppLike({ over = {}, onStartSession }: { over?: Record<string, unknown>; onStartSession: () => void }) {
  const open = useHelloCodexStore((s) => s.open === 'takeover')
  const chain = bootChain({ ...BASE, ...over, helloCodexOpen: open })
  return h(HelloCodexHost, { gatesClear: chain.helloCodexGatesClear, takeoverTurn: chain.helloCodexTurn, onStartSession })
}

// ---------------------------------------------------------------------------

describe('Hello Codex: when it shows', () => {
  it('AC1: due when Codex is enabled, discovered and compatible, with one active signed-in account; not due when any of these is missing', () => {
    expect(helloCodexDue(withCodex(), {})).toBe(true)
    // A too-new CLI still runs (the setup page calls it usable): not refused.
    expect(helloCodexDue(withCodex({ compatibility: 'too-new' }), {})).toBe(true)

    const notDue: Array<[string, ReturnType<typeof withCodex> | null]> = [
      ['no snapshot', null],
      ['Codex off', withCodex({ enabled: false, preference: 'off' })],
      ['Codex undecided', withCodex({ preference: 'undecided' })],
      ['CLI missing', withCodex({ discoveryState: 'missing' })],
      ['CLI not checked yet', withCodex({ discoveryState: 'unchecked' })],
      ['CLI too old', withCodex({ compatibility: 'too-old' })],
      ['CLI unsupported', withCodex({ compatibility: 'unsupported' })],
      ['no account', withCodex({}, [])],
      ['account inactive', withCodex({}, [account({ id: 'a', providerId: 'codex', identityId: 'i', lifecycle: 'inactive' })])],
      ['account signed out', withCodex({}, [account({ id: 'a', providerId: 'codex', identityId: 'i', lastKnownAuthState: 'signed-out' })])],
      ['account blocked', withCodex({}, [account({ id: 'a', providerId: 'codex', identityId: 'i', operationalState: 'blocked' })])],
      ['only a Claude account', withCodex({}, [account({ id: 'c', providerId: 'claude', identityId: 'i' })])],
    ]
    for (const [why, snap] of notDue) expect(helloCodexDue(snap, {}), why).toBe(false)
    // Seen already: not due, whatever the snapshot says.
    expect(helloCodexDue(withCodex(), { helloCodexSeenVersion: '2.1.1' })).toBe(false)
  })

  it('AC2: an adopted external sign-in that is still unverified, as the only account, does not make it due', () => {
    expect(local.external && local.unverified).toBe(true)
    expect(codexSetUp(withCodex({}, [local]))).toBe(false)
    expect(helloCodexDue(withCodex({}, [local]), {})).toBe(false)
    // An unverified sign-in of any kind is not "set up" either.
    const realmOnly = account({ id: 'r', providerId: 'codex', identityId: 'i', unverified: true, identityAssurance: 'realm-only' })
    expect(helloCodexDue(withCodex({}, [realmOnly]), {})).toBe(false)
    // External sign-ins are excluded outright, whatever else they say.
    const externalVouched = account({ id: 'x', providerId: 'codex', identityId: 'i', external: true, unverified: false })
    expect(helloCodexDue(withCodex({}, [externalVouched]), {})).toBe(false)
    // A managed, signed-in account beside it makes it due.
    expect(helloCodexDue(withCodex({}, [local, work]), {})).toBe(true)
  })

  describe('AC3: inside onboarding, the helloCodex page follows codexSetup and is skipped when its when() is false', () => {
    const onComplete = vi.fn()
    beforeEach(() => { onComplete.mockReset() })

    const page = (): string => {
      if (byTest('assistants-cards')) return 'assistants'
      if (byTest('hello-codex')) return 'helloCodex'
      return byTest('page')?.getAttribute('data-page') ?? '(none)'
    }
    const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() }) }
    async function choose(choice: 'claude' | 'codex' | 'both') {
      await click(`assistants-card-${choice}`)
      await click('assistants-continue')
      await flush()
    }
    async function walk(choice: 'claude' | 'codex' | 'both'): Promise<string[]> {
      const seenPages: string[] = []
      for (let i = 0; i < 40; i++) {
        const id = page()
        seenPages.push(id)
        if (id === 'finish' || id === '(none)') return seenPages
        if (id === 'assistants') await choose(choice)
        else if (id === 'helloCodex') await click('hc-skip')
        else await click('stub-next')
      }
      throw new Error(`no end: ${seenPages.join(' > ')}`)
    }
    const mount = (whatsNewOnly = false, codexSetupOnly = false) =>
      render(h(OnboardingHarness, { onComplete, whatsNewOnly, codexSetupOnly }))

    it('the registry places it straight after codexSetup, fresh installs only, never made due for an upgrader', () => {
      const ids = STEPS.map((s) => s.id)
      expect(ids.indexOf('helloCodex')).toBe(ids.indexOf('codexSetup') + 1)
      const step = STEPS.find((s) => s.id === 'helloCodex')!
      expect(step.freshInstallOnly).toBe(true)
      expect(step.requiresSetup).toBe(false)
      expect(stepsNewSince('2.1.0', { codexEnabled: true }).map((s) => s.id)).not.toContain('helloCodex')
      const completed = { onboardingCompletedVersion: '3', completedSteps: Object.fromEntries(ids.filter((i) => i !== 'helloCodex').map((i) => [i, '2.1.0'])) }
      expect(deriveOnboarding(completed, { codexEnabled: true }).due).toBe(false)
    })

    it('fresh install, Codex chosen and set up: codexSetup, then helloCodex, then the rest', async () => {
      useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true })
      await mount()
      expect(await walk('both')).toEqual([
        'welcome', 'whatsNewV2Fresh', 'assistants', 'commandBar', 'findClaude', 'compatibility', 'accounts',
        'codexSetup', 'helloCodex', 'github', 'statusline', 'builtinTools', 'transparency', 'finish',
      ])
    })

    it('decided when codexSetup is left: signing in on that page makes it the next page', async () => {
      await mount()
      for (let i = 0; i < 40 && page() !== 'codexSetup'; i++) {
        if (page() === 'assistants') await choose('codex')
        else await click('stub-next')
      }
      expect(page()).toBe('codexSetup')
      // The sign-in lands while the page is open.
      useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true })
      await click('stub-next')
      expect(page()).toBe('helloCodex')
    })

    it('skipped when its when() is false: Codex not set up, Codex not chosen, or already seen', async () => {
      await mount()
      const notSetUp = await walk('codex')
      expect(notSetUp).toContain('codexSetup')
      expect(notSetUp).not.toContain('helloCodex')
      remount()

      useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true })
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
      await mount()
      expect(await walk('claude')).not.toContain('helloCodex')
      remount()

      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
      useAppMetaStore.setState({ meta: { helloCodexSeenVersion: '2.1.0' } })
      await mount()
      const alreadySeen = await walk('both')
      expect(alreadySeen).toContain('codexSetup')
      expect(alreadySeen).not.toContain('helloCodex')
    })

    it('the upgrader handed Codex setup this run meets it right after, and nothing else', async () => {
      useAppMetaStore.setState({ meta: { lastSeenVersion: '2.1.0' } })
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true } })
      useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true })
      noteClaudeMissingAtSetup()
      await mount(false, true)
      expect(page()).toBe('codexSetup')
      await click('stub-next')
      expect(page()).toBe('helloCodex')
      await click('hc-skip')
      expect(onComplete).toHaveBeenCalledWith(false)
    })

    it('the release-notes run plus that hand-off: the notes, Codex setup, then helloCodex', async () => {
      useAppMetaStore.setState({ meta: { lastSeenVersion: '2.1.0' } })
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true } })
      useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true })
      noteClaudeMissingAtSetup()
      await mount(true)
      expect(page()).toBe('whatsNewV2')
      await click('stub-next')
      expect(page()).toBe('codexSetup')
      await click('stub-next')
      expect(page()).toBe('helloCodex')
      await click('hc-skip')
      expect(onComplete).toHaveBeenCalledWith(false)
    })

    it('an upgrader is never re-walked for it: not in the notes run, not in a full re-walk', async () => {
      useAppMetaStore.setState({ meta: { lastSeenVersion: '2.1.0' } })
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, codexEnabled: true } })
      useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true })
      await mount(true)
      expect(page()).toBe('whatsNewV2')
      await click('stub-next')
      expect(onComplete).toHaveBeenCalledWith(false)
      remount()
      await mount()
      expect(await walk('both')).not.toContain('helloCodex')
    })
  })

  it('AC4: outside onboarding, the first snapshot that makes it due shows the takeover once, after the boot gates and any open dialog', async () => {
    const onStartSession = vi.fn()
    const takeover = () => byTest('hello-codex-takeover')

    // Not set up yet: nothing.
    useProviderAccountsStore.setState({ snapshot: withCodex({}, []), loaded: true })
    await render(h(AppLike, { onStartSession }))
    expect(takeover()).toBeNull()

    // Due, but a boot gate still has its turn (the resume prompt): waits.
    await render(h(AppLike, { onStartSession, over: { resumePending: true } }))
    await act(async () => { useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true }) })
    expect(takeover()).toBeNull()
    expect(useHelloCodexStore.getState().open).toBeNull()
    // So does a gate that is due but not up yet.
    await render(h(AppLike, { onStartSession, over: { whatsNewDue: true } }))
    expect(takeover()).toBeNull()

    // Gates clear, but a dialog is open: waits.
    const release = usePaneOcclusionStore.getState().acquireOverlay()
    await render(h(AppLike, { onStartSession }))
    expect(takeover()).toBeNull()
    expect(useHelloCodexStore.getState().open).toBeNull()

    // The dialog closes: the takeover opens, as a real page with an <h1>.
    await act(async () => { release() })
    expect(takeover()).not.toBeNull()
    expect(container.querySelector('h1')?.textContent).toBe('Hello, Codex')
    expect(byTest('hello-codex')!.getAttribute('role')).toBe('dialog')
    // Opaque over the app, not a scrim.
    expect(takeover()!.style.background).toBe('var(--surface-base)')
    // Its own overlay does not close it.
    expect(usePaneOcclusionStore.getState().overlays).toBeGreaterThan(0)
    await act(async () => { useProviderAccountsStore.setState({ snapshot: { ...withCodex(), revision: 2 }, loaded: true }) })
    expect(takeover()).not.toBeNull()

    // Once: left, it never opens again, whatever the snapshot does.
    await click('hc-skip')
    expect(takeover()).toBeNull()
    await act(async () => { useProviderAccountsStore.setState({ snapshot: { ...withCodex(), revision: 3 }, loaded: true }) })
    expect(takeover()).toBeNull()
    expect(useHelloCodexStore.getState().open).toBeNull()

    // The boot chain App uses gives it the LAST turn: after every gate, the
    // *Due waits included.
    expect(bootChain({ ...BASE, helloCodexOpen: true })).toEqual({ gate: 'helloCodex', helloCodexGatesClear: true, helloCodexTurn: true })
    expect(bootChain({ ...BASE, helloCodexOpen: true, multiSpawnIntroDue: true })).toMatchObject({ gate: 'multiSpawnIntro', helloCodexGatesClear: false, helloCodexTurn: false })
    expect(bootChain({ ...BASE, helloCodexOpen: false, resumePending: true })).toMatchObject({ gate: 'resume', helloCodexGatesClear: false })
    expect(bootChain({ ...BASE, helloCodexOpen: false, onboardingDue: true }).helloCodexGatesClear).toBe(false)
    expect(bootChain({ ...BASE, helloCodexOpen: false, whatsNewDue: true })).toMatchObject({ gate: null, helloCodexGatesClear: false })
    expect(bootChain({ ...BASE, helloCodexOpen: false })).toMatchObject({ gate: null, helloCodexGatesClear: true, helloCodexTurn: false })
    expect(pickBootGate({ ...BASE, helloCodexOpen: true })).toBe('helloCodex')
    // And App passes exactly those answers to the host.
    const app = src('src/renderer/App.tsx')
    expect(app).toContain('const boot = bootChain(bootGateState)')
    expect(app).toContain('const bootGate = boot.gate')
    expect(app).toContain('gatesClear={boot.helloCodexGatesClear}')
    expect(app).toContain('takeoverTurn={boot.helloCodexTurn}')
    expect(app).toContain('helloCodexOpen: helloCodexTakeoverOpen,')
    // The readiness rule itself.
    expect(helloCodexTakeoverReady({ due: true, open: null, gatesClear: true, overlays: 0 })).toBe(true)
    expect(helloCodexTakeoverReady({ due: true, open: null, gatesClear: true, overlays: 1 })).toBe(false)
    expect(helloCodexTakeoverReady({ due: true, open: null, gatesClear: false, overlays: 0 })).toBe(false)
    expect(helloCodexTakeoverReady({ due: false, open: null, gatesClear: true, overlays: 0 })).toBe(false)
    expect(helloCodexTakeoverReady({ due: true, open: 'replay', gatesClear: true, overlays: 0 })).toBe(false)
  })
})

describe('Hello Codex: seen once, replayable', () => {
  const lastPage = async () => { await click('hc-dot-5'); expect(heading()).toBe('How Codex differs') }
  const ways: Array<[string, () => Promise<void>]> = [
    ['Skip', () => click('hc-skip')],
    ['Escape', () => key('Escape')],
    ['Done', async () => { await lastPage(); await click('hc-done') }],
    ['Start a Codex session', async () => { await lastPage(); await click('hc-primary') }],
  ]

  it('AC5: Done, Skip, Escape and "Start a Codex session" each write helloCodexSeenVersion; it never shows again, upgrades included', async () => {
    // The takeover: each way out stamps.
    for (const [why, leave] of ways) {
      useAppMetaStore.setState({ meta: {} })
      const onClose = vi.fn()
      const onStartSession = vi.fn()
      await renderArmed(h(HelloCodexTakeover, { onClose, onStartSession }))
      await leave()
      expect(seen(), why).toBe(VERSION)
      expect(onClose, why).toHaveBeenCalledTimes(1)
      expect(onStartSession, why).toHaveBeenCalledTimes(why === 'Start a Codex session' ? 1 : 0)
      remount()
    }

    // The onboarding page: the same four, and each moves the run on.
    for (const [why, leave] of ways) {
      useAppMetaStore.setState({ meta: {} })
      const onNext = vi.fn()
      const onStartSession = vi.fn()
      await render(h(HelloCodexStep, { onNext, onStartSession }))
      await leave()
      expect(seen(), why).toBe(VERSION)
      expect(onNext, why).toHaveBeenCalledTimes(1)
      expect(onStartSession, why).toHaveBeenCalledTimes(why === 'Start a Codex session' ? 1 : 0)
      remount()
    }

    // Never again, after an upgrade too: presence is what counts.
    ;(globalThis as any).__APP_VERSION__ = '2.2.0'
    expect(helloCodexDue(withCodex(), { helloCodexSeenVersion: VERSION })).toBe(false)
    useAppMetaStore.setState({ meta: { helloCodexSeenVersion: VERSION } })
    useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true })
    await render(h(HelloCodexHost, { gatesClear: true, takeoverTurn: true, onStartSession: vi.fn() }))
    expect(byTest('hello-codex-takeover')).toBeNull()
    expect(useHelloCodexStore.getState().open).toBeNull()
  })

  it('AC6: a replay from the Feature Guide or Settings shows it; it leaves a written stamp unchanged, and stamps only if the page was still due', async () => {
    // The links are offered only once Codex is set up: page 1 says the
    // account is ready.
    const guideLink = () => container.querySelector('[data-ux-id="card-codex-provider"] [data-ux-id="show-codex-intro"]') as HTMLElement | null
    useProviderAccountsStore.setState({ snapshot: withCodex({}, []), loaded: true })
    await render(h(FeatureGuidePage, { onNavigateToSessions: vi.fn(), onStartTour: vi.fn() }))
    await act(async () => { (container.querySelector('[data-ux-id="rail-integrations"]') as HTMLElement).click() })
    expect(container.querySelector('[data-ux-id="card-codex-provider"]')).not.toBeNull()
    expect(guideLink()).toBeNull()
    await act(async () => { useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true }) })
    expect(guideLink()!.textContent).toBe('Show the Codex introduction')
    await act(async () => { guideLink()!.click() })
    expect(useHelloCodexStore.getState().open).toBe('replay')
    remount()

    // Settings, Accounts: the Codex row of the Providers card, set up only.
    useHelloCodexStore.setState({ open: null })
    useProviderAccountsStore.setState({ snapshot: withCodex({}, [local]), loaded: true })
    await render(h(ProvidersCard))
    expect(byTest('provider-row-codex')).not.toBeNull()
    expect(byTest('provider-codex-intro')).toBeNull()
    await act(async () => { useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true }) })
    expect(byTest('provider-codex-intro')!.textContent).toBe('Show the Codex introduction')
    // Only on the Codex row.
    expect(byTest('provider-row-claude')!.querySelector('[data-testid="provider-codex-intro"]')).toBeNull()
    await click('provider-codex-intro')
    expect(useHelloCodexStore.getState().open).toBe('replay')
    remount()

    // Shown by the host whatever the boot chain says. Already seen: every way
    // out leaves the stamp as it was.
    const onStartSession = vi.fn()
    for (const [why, leave] of ways) {
      useAppMetaStore.setState({ meta: { helloCodexSeenVersion: '2.1.0' } })
      useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true })
      useHelloCodexStore.setState({ open: null })
      showHelloCodexReplay()
      await render(h(HelloCodexHost, { gatesClear: false, takeoverTurn: false, onStartSession }))
      expect(byTest('hello-codex-replay'), why).not.toBeNull()
      await leave()
      expect(byTest('hello-codex-replay'), why).toBeNull()
      expect(useHelloCodexStore.getState().open, why).toBeNull()
      expect(seen(), why).toBe('2.1.0')
      remount()
    }
    expect(onStartSession).toHaveBeenCalledTimes(1)

    // Not set up (the store asked directly): nothing is written either.
    useAppMetaStore.setState({ meta: {} })
    useProviderAccountsStore.setState({ snapshot: withCodex({}, []), loaded: true })
    showHelloCodexReplay()
    await render(h(AppLike, { onStartSession }))
    await click('hc-skip')
    expect(seen()).toBeUndefined()
    remount()

    // Still due and unseen: the replay IS the showing, so it stamps, and the
    // takeover does not show all five pages again right after.
    useAppMetaStore.setState({ meta: {} })
    useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true })
    useHelloCodexStore.setState({ open: null })
    showHelloCodexReplay()
    await render(h(AppLike, { onStartSession }))
    expect(byTest('hello-codex-replay')).not.toBeNull()
    await click('hc-skip')
    expect(seen()).toBe(VERSION)
    expect(byTest('hello-codex-takeover')).toBeNull()
    expect(useHelloCodexStore.getState().open).toBeNull()
  })
})

describe('Hello Codex: the pages', () => {
  it('AC7: Hello, Accounts, Launch and resume, Code review, Differences, in that order, counted "N of 5"; arrow keys and dots move between them', async () => {
    const order = ['Hello, Codex', 'Accounts', 'Launch and resume', 'Code review', 'How Codex differs']
    for (const inputs of [{ claudeReview: true, claudeOn: true }, { claudeReview: true, claudeOn: false }]) {
      expect(helloCodexPages(inputs).map((p) => p.heading)).toEqual(order)
    }
    await render(h(HelloCodex, { onFinish: vi.fn() }))
    // Right arrow and Next walk forward.
    for (let i = 0; i < order.length; i++) {
      expect(heading()).toBe(order[i])
      expect(byTest('hc-eyebrow')!.textContent).toBe(`Codex - ${i + 1} of 5`)
      expect(byTest(`hc-dot-${i + 1}`)!.getAttribute('aria-current')).toBe('page')
      if (i === order.length - 1) break
      if (i % 2 === 0) await key('ArrowRight')
      else await click('hc-primary')
    }
    // Past the last page, Right does nothing; Left walks back.
    await key('ArrowRight')
    expect(heading()).toBe(order[4])
    await key('ArrowLeft')
    expect(heading()).toBe(order[3])
    await click('hc-back')
    expect(heading()).toBe(order[2])
    // The dots jump anywhere, and are named for their page.
    await click('hc-dot-1')
    expect(heading()).toBe(order[0])
    await key('ArrowLeft')
    expect(heading()).toBe(order[0])
    expect(Array.from(byTest('hc-dots')!.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))).toEqual(order)
    await click('hc-dot-4')
    expect(heading()).toBe('Code review')
    // 24px hit targets around each dot.
    expect(src('src/renderer/onboarding/onboarding.css')).toMatch(/\.ob-root \.wn-fdot \{ width: 24px; height: 24px;/)
    expect(byTest('hc-dot-1')!.className).toContain('wn-fdot')
  })

  it('AC8 (amended): the first page says Codex sessions and reviews run on this computer only in this release; the launch page says the SSH options are off for Codex and the dialog says why', async () => {
    await render(h(HelloCodex, { onFinish: vi.fn() }))
    expect(pageText()).toContain('In this release, Codex sessions and Codex reviews run on this computer only, not over SSH.')
    expect(byTest('hc-local-note')!.textContent).toBe('Local sessions only in this release')
    await click('hc-dot-3')
    expect(heading()).toBe('Launch and resume')
    expect(pageText()).toContain('Local only for now. The SSH options are off for Codex, and the dialog says why.')
    // The drawing keeps the approved wording.
    expect(byTest('hc-art-launch')!.textContent).toContain('SSHNot available for Codex in this release')
    // And the dialog does say why, in the words the page points at.
    expect(src('src/renderer/components/SessionDialog.tsx')).toContain('Codex runs on this computer only in this release.')
  })

  it('AC9: the review page shows the Claude-review line only when claude_review ships in the build', async () => {
    // This build ships it: the flag is read from the build's own tool list.
    expect(CLAUDE_REVIEW_SHIPS).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(DEFAULT_CONDUCTOR_TOOLS, 'claudeReview')).toBe(true)

    // Default (the build, Claude Code on): both directions.
    await render(h(HelloCodex, { onFinish: vi.fn() }))
    await click('hc-dot-4')
    expect(pointsText()).toContain('From a Codex session.')
    expect(pointsText()).toContain('Each direction has its own switch')
    expect(byTest('hc-flow-claude')).not.toBeNull()
    expect(byTest('hc-flow-codex')).not.toBeNull()
    await click('hc-dot-5')
    expect(container.querySelector('[data-row="Code review"] [data-cell="codex"]')!.textContent).toBe('Asks Claude')
    remount()

    // With it off: the Claude-to-Codex direction only, and nothing that
    // claims the other.
    await render(h(HelloCodex, { onFinish: vi.fn(), claudeReview: false }))
    await click('hc-dot-4')
    expect(pageText()).toContain('From a Claude session.')
    expect(pageText()).not.toContain('From a Codex session.')
    expect(pageText()).not.toContain('Claude review')
    expect(pageText()).not.toContain('Each direction')
    expect(pageText()).toContain('Codex review has its own switch')
    expect(byTest('hc-flow-claude')).not.toBeNull()
    expect(byTest('hc-flow-codex')).toBeNull()
    await click('hc-dot-5')
    expect(container.querySelector('[data-row="Code review"] [data-cell="codex"]')!.textContent).toBe('Not yet')
  })

  it('AC10: "Start a Codex session" opens New saved config with the Codex card selected', async () => {
    // The page hands the request on (the takeover: straight away).
    const onStartSession = vi.fn()
    await render(h(HelloCodexTakeover, { onClose: vi.fn(), onStartSession }))
    await click('hc-dot-5')
    expect(byTest('hc-primary')!.textContent).toBe('Start a Codex session')
    await click('hc-primary')
    expect(onStartSession).toHaveBeenCalledTimes(1)
    remount()

    // Inside onboarding, the harness hands it to App when the run ends.
    const onComplete = vi.fn()
    useAppMetaStore.setState({ meta: { lastSeenVersion: '2.1.0' } })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true } })
    useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true })
    noteClaudeMissingAtSetup()
    await render(h(OnboardingHarness, { onComplete, codexSetupOnly: true }))
    await click('stub-next')
    await click('hc-dot-5')
    await click('hc-primary')
    expect(onComplete).toHaveBeenCalledWith(false, { startCodexSession: true })
    remount()

    // The dialog App opens for it: New saved config, Codex card chosen.
    const codexRadio = () => {
      const g = container.querySelector('[role="radiogroup"][aria-label="Provider"]')!
      const lab = Array.from(g.querySelectorAll('label')).find((l) => l.querySelector('span')?.textContent === 'Codex')!
      return lab.querySelector('input[type="radio"]') as HTMLInputElement
    }
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: true, codexEnabled: true } })
    await render(h(SessionDialog as any, { onConfirm: vi.fn(), onCancel: vi.fn(), initialProvider: 'codex' }))
    expect(container.textContent).toContain('New saved config')
    expect(codexRadio().checked).toBe(true)
    remount()
    // Every other way in opens it as before.
    await render(h(SessionDialog as any, { onConfirm: vi.fn(), onCancel: vi.fn() }))
    expect(codexRadio().checked).toBe(false)
    // App wires every place's request to exactly that dialog (held while the
    // resume prompt waits; see the round 1 cases below).
    const app = src('src/renderer/App.tsx')
    expect(app).toMatch(/const startCodexSession = \(\) => \{\s*setGuidedConfigProvider\('codex'\)\s*setShowGuidedConfig\(true\)/)
    expect(app).toContain('const requestCodexSession = useHeldCodexSessionStart(pendingRestore !== null, startCodexSession)')
    expect(app).toContain('initialProvider={guidedConfigProvider}')
    expect(app).toContain('if (extra?.startCodexSession) requestCodexSession()')
    expect(app).toContain('onStartSession={requestCodexSession}')
  })
})

describe('Hello Codex: presentation and copy', () => {
  it('AC11: semantic tokens only (no hard-coded colours); renders in the dark and light themes', async () => {
    const css = src('src/renderer/onboarding/onboarding.css')
    const start = css.indexOf('/* Hello Codex (WP2 commit 6f')
    const end = css.indexOf('/* end Hello Codex */')
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const hcCss = css.slice(start, end)
    const tsx = src('src/renderer/onboarding/HelloCodex.tsx')
    const HARD = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/
    expect(hcCss).not.toMatch(HARD)
    expect(tsx.replace(/&[a-z]+;/g, '')).not.toMatch(HARD)

    // Every token it paints with is defined for the dark theme AND redefined
    // for the light one, so it is theme-aware rather than dark-only.
    const styles = src('src/renderer/styles.css').replace(/\r\n/g, '\n')
    const blockOf = (sel: string) => {
      const at = styles.indexOf(`\n${sel} {`)
      expect(at, sel).toBeGreaterThan(-1)
      let depth = 0
      for (let i = styles.indexOf('{', at); i < styles.length; i++) {
        if (styles[i] === '{') depth++
        else if (styles[i] === '}' && --depth === 0) return styles.slice(at, i)
      }
      throw new Error(`unclosed ${sel}`)
    }
    const defined = (block: string) => new Set(Array.from(block.matchAll(/(--[a-z0-9-]+)\s*:/g), (m) => m[1]))
    const dark = new Set([...defined(blockOf('@theme')), ...defined(blockOf(':root'))])
    const light = defined(blockOf('[data-theme="light"]'))
    const used = new Set(Array.from((hcCss + tsx).matchAll(/var\((--[a-z0-9-]+)/g), (m) => m[1]))
    expect(used.size).toBeGreaterThan(10)
    for (const v of used) {
      expect(dark.has(v), `${v} in the dark theme`).toBe(true)
      expect(light.has(v), `${v} in the light theme`).toBe(true)
    }

    // It renders under either theme.
    for (const theme of ['dark', 'light']) {
      document.documentElement.setAttribute('data-theme', theme)
      await render(h(HelloCodex, { onFinish: vi.fn() }))
      expect(heading(), theme).toBe('Hello, Codex')
      remount()
    }
    document.documentElement.removeAttribute('data-theme')
  })

  it('AC12: no em dashes and no emoji in the copy; no \\u{} escapes in the JSX', async () => {
    const EM_DASH = String.fromCharCode(0x2014)
    const EMOJI = /\p{Extended_Pictographic}/u
    for (const claudeReview of [true, false]) {
      for (const claudeOn of [true, false]) {
        const copy = helloCodexPages({ claudeReview, claudeOn })
          .flatMap((p) => [p.heading, p.tagline, p.where ?? '', p.localNote ?? '', ...p.points.flatMap((pt) => [pt.lead, pt.rest])])
          .concat(helloCodexComparison({ claudeReview, claudeOn }).flat())
        for (const line of copy) {
          expect(line.includes(EM_DASH), line).toBe(false)
          expect(EMOJI.test(line), line).toBe(false)
        }
      }
      // And what is actually on screen, page by page, footer included.
      await render(h(HelloCodex, { onFinish: vi.fn(), claudeReview }))
      for (let i = 1; i <= 5; i++) {
        await click(`hc-dot-${i}`)
        const text = container.textContent ?? ''
        expect(text.includes(EM_DASH), `page ${i}`).toBe(false)
        expect(EMOJI.test(text), `page ${i}`).toBe(false)
      }
      remount()
    }
    const escape = String.fromCharCode(92) + 'u{'
    for (const f of ['src/renderer/onboarding/HelloCodex.tsx', 'src/renderer/onboarding/hello-codex.ts']) {
      expect(src(f).includes(escape), f).toBe(false)
    }
  })

  it('AC13: focus lands on the primary button on entry; reduced motion cuts pages instead of sliding', async () => {
    // Entry: the onboarding page and the takeover both focus Next.
    await render(h(HelloCodex, { onFinish: vi.fn() }))
    expect(document.activeElement).toBe(byTest('hc-primary'))
    // The primary button is one element on every page, so focus stays on it.
    await click('hc-primary')
    await click('hc-primary')
    expect(document.activeElement).toBe(byTest('hc-primary'))
    remount()
    await render(h(HelloCodexTakeover, { onClose: vi.fn(), onStartSession: vi.fn() }))
    expect(document.activeElement).toBe(byTest('hc-primary'))
    remount()

    // Motion allowed: pages slide, in the direction of travel.
    await render(h(HelloCodex, { onFinish: vi.fn() }))
    await key('ArrowRight')
    expect(byTest('hc-page')!.getAttribute('data-transition')).toBe('slide')
    expect(byTest('hc-page')!.className).toContain('hc-slide-next')
    await key('ArrowLeft')
    expect(byTest('hc-page')!.className).toContain('hc-slide-prev')
    remount()

    // Reduced motion: they cut.
    reducedMotion = true
    await render(h(HelloCodex, { onFinish: vi.fn() }))
    await key('ArrowRight')
    expect(heading()).toBe('Accounts')
    expect(byTest('hc-page')!.getAttribute('data-transition')).toBe('cut')
    expect(byTest('hc-page')!.className).not.toContain('hc-slide')
    // And the stylesheet agrees, for any system that asks.
    expect(src('src/renderer/onboarding/onboarding.css')).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.ob-root \.hc-page \{ animation: none !important; \} \}/)
  })

  // AC14 is commit 7's (the guidance slice: the Feature Guide and app-knowledge
  // entries for Codex). It stays pending until that slice writes them.
  it.todo('AC14: the Feature Guide and app-knowledge entries (commit 7) say what the pages say: local only, the reviewer default, confirming an existing sign-in each launch')
})

describe('Hello Codex: review round 1', () => {
  it('a Codex-only install (Claude Code off) reads nothing that needs Claude: page 1, the review page and the table', async () => {
    const off = { claudeReview: true, claudeOn: false }
    const pages = helloCodexPages(off)
    expect(pages[0].tagline).toBe('Codex now runs in this window.')
    expect(pages[0].points.map((p) => p.lead)).toEqual(['Your Codex account is ready.', 'Sessions as tabs.', 'On this computer.'])
    expect(pages[3].points.map((p) => p.lead)).toEqual(['It needs Claude Code too.', 'A separate reviewer, not another session.'])
    expect(pages[3].where).toBe('Settings, Accounts')
    expect(helloCodexComparison(off).find(([w]) => w === 'Code review')![2]).toBe('Needs Claude Code on')
    // The Claude-review line needs BOTH the build and Claude Code on.
    for (const [claudeReview, claudeOn, shown] of [[true, true, true], [true, false, false], [false, true, false], [false, false, false]] as const) {
      const leads = helloCodexPages({ claudeReview, claudeOn })[3].points.map((p) => p.lead)
      expect(leads.includes('From a Codex session.'), `${claudeReview} ${claudeOn}`).toBe(shown)
    }

    // Live: off by the saved setting, and off by main's switch.
    for (const [why, settings, snap] of [
      ['saved setting off', { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true }, withCodex()],
      ['main switched it off', { ...DEFAULT_SETTINGS, codexEnabled: true }, withCodex({}, [work], { enabled: false })],
    ] as const) {
      useSettingsStore.setState({ settings: settings as any })
      useProviderAccountsStore.setState({ snapshot: snap, loaded: true })
      expect(claudeCodeOn(useSettingsStore.getState().settings, snap), why).toBe(false)
      await render(h(HelloCodex, { onFinish: vi.fn() }))
      expect(byTest('hc-tagline')!.textContent, why).toBe('Codex now runs in this window.')
      // Page 1, drawing included, never mentions Claude: no Claude tab.
      expect(pageText(), why).not.toContain('Claude')
      expect(byTest('hc-art-hello')!.querySelector('[data-testid="provider-mark-claude"]'), why).toBeNull()
      expect(byTest('hc-art-hello')!.querySelectorAll('[data-testid="provider-mark-codex"]').length, why).toBe(2)
      expect(pageText(), why).toContain('Sessions as tabs. Codex sessions open as tabs, like any other session.')
      await click('hc-dot-4')
      expect(pointsText(), why).toContain('It needs Claude Code too. Code review asks the other provider for a second opinion, so it needs Claude Code on as well. Turn it on in Settings, Accounts.')
      expect(pointsText(), why).not.toContain('From a')
      expect(pointsText(), why).not.toContain('Each direction')
      expect(pointsText(), why).not.toContain('switch')
      expect(byTest('hc-where')!.textContent, why).toBe('Where: Settings, Accounts')
      await click('hc-dot-5')
      expect(container.querySelector('[data-row="Code review"] [data-cell="codex"]')!.textContent, why).toBe('Needs Claude Code on')
      remount()
    }

    // Claude Code on again: the Claude lines are back.
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: true, codexEnabled: true } })
    useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true })
    await render(h(HelloCodex, { onFinish: vi.fn() }))
    expect(byTest('hc-tagline')!.textContent).toBe('Codex now runs beside Claude, in the same window.')
    expect(pageText()).toContain('Sessions side by side.')
    expect(byTest('hc-art-hello')!.querySelector('[data-testid="provider-mark-claude"]')).not.toBeNull()
    await click('hc-dot-4')
    expect(pointsText()).toContain('From a Codex session.')
  })

  it('A1: the close dialogs paint above the takeover and keep their keys; the takeover acts on none while one is open', async () => {
    // Layering: the shared z-50, rendered before the close dialogs in App.
    await render(h(HelloCodexTakeover, { onClose: vi.fn(), onStartSession: vi.fn() }))
    expect(byTest('hello-codex-takeover')!.className).toContain('z-50')
    expect(byTest('hello-codex-takeover')!.className).not.toContain('z-[100]')
    remount()
    const app = src('src/renderer/App.tsx')
    const host = app.indexOf('<HelloCodexHost')
    expect(host).toBeGreaterThan(0)
    expect(app.indexOf('<SshCloseDialog />')).toBeGreaterThan(host)
    expect(app.indexOf('<CloseDialog')).toBeGreaterThan(host)

    // Keys: with the close dialog open above it, Escape is the dialog's.
    const onClose = vi.fn()
    const onCancel = vi.fn()
    const both = (withDialog: boolean) => h(React.Fragment, null,
      h(HelloCodexTakeover, { onClose, onStartSession: vi.fn() }),
      withDialog ? h(CloseDialog, { mode: 'close', sessionCount: 2, onSaveAndClose: vi.fn(), onCloseWithoutSaving: vi.fn(), onCancel }) : null)
    await renderArmed(both(true))
    await key('Escape')
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    expect(seen()).toBeUndefined()
    await key('ArrowRight')
    expect(heading()).toBe('Hello, Codex')
    // The dialog gone, the takeover's keys are its own again.
    await render(both(false))
    await key('ArrowRight')
    expect(heading()).toBe('Accounts')
    await key('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(seen()).toBe(VERSION)
  })

  it('A1 (round 2): a dialog left open in a hidden page tab or session does not take the takeover\'s keys; a visible one does', async () => {
    // Page tabs and sessions stay mounted while hidden: an ancestor with
    // display: none (App.tsx). jsdom has no layout, but it computes inline
    // display, which is what the check reads.
    const onClose = vi.fn()
    const marker = (hidden: boolean) => h('div', { style: hidden ? { display: 'none' } : undefined, 'data-testid': 'tab' },
      h('div', { 'data-dialog-overlay': '' }, h('div', { role: 'dialog', 'aria-modal': 'true' }, 'Left open')))
    const both = (hidden: boolean | null) => h(React.Fragment, null,
      h(HelloCodexTakeover, { onClose, onStartSession: vi.fn() }),
      hidden === null ? null : marker(hidden))

    // Hidden: the arming guard still holds...
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await render(both(true))
    const early = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => { byTest('hc-primary')!.dispatchEvent(early) })
    expect(early.defaultPrevented).toBe(true)
    await act(async () => { vi.advanceTimersByTime(HELLO_CODEX_ARM_MS) })
    vi.useRealTimers()
    // ...and once armed the takeover's keys are its own.
    await key('ArrowRight')
    expect(heading()).toBe('Accounts')
    await key('ArrowRight', { repeat: true })
    expect(heading()).toBe('Accounts')

    // The same marker shown: the keys are left to it.
    await render(both(false))
    await key('ArrowRight')
    expect(heading()).toBe('Accounts')
    await key('Escape')
    expect(onClose).not.toHaveBeenCalled()

    // Hidden again: Escape is Skip.
    await render(both(true))
    await key('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(seen()).toBe(VERSION)
  })

  it('A2: keys are ignored for a moment after the takeover opens, and auto-repeated keys always', async () => {
    const onClose = vi.fn()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    await render(h(HelloCodexTakeover, { onClose, onStartSession: vi.fn() }))
    // Not armed: nothing pages, nothing dismisses, and Enter on the focused
    // Next is cancelled (so the button is not pressed).
    await key('ArrowRight')
    await key('Escape')
    expect(heading()).toBe('Hello, Codex')
    expect(onClose).not.toHaveBeenCalled()
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => { byTest('hc-primary')!.dispatchEvent(enter) })
    expect(enter.defaultPrevented).toBe(true)
    // Armed after the delay.
    await act(async () => { vi.advanceTimersByTime(HELLO_CODEX_ARM_MS) })
    vi.useRealTimers()
    const enter2 = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => { byTest('hc-primary')!.dispatchEvent(enter2) })
    expect(enter2.defaultPrevented).toBe(false)
    await key('ArrowRight')
    expect(heading()).toBe('Accounts')
    // A held key's repeats are swallowed.
    await key('ArrowRight', { repeat: true })
    expect(heading()).toBe('Accounts')
    const held = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, repeat: true })
    await act(async () => { byTest('hc-primary')!.dispatchEvent(held) })
    expect(held.defaultPrevented).toBe(true)
    await key('Escape', { repeat: true })
    expect(onClose).not.toHaveBeenCalled()
    // A replay is asked for, so it is armed at once.
    remount()
    useHelloCodexStore.setState({ open: null })
    showHelloCodexReplay()
    await render(h(HelloCodexHost, { gatesClear: false, takeoverTurn: false, onStartSession: vi.fn() }))
    await key('ArrowRight')
    expect(heading()).toBe('Accounts')
  })

  it('A3: global shortcuts are suppressed while the takeover or a replay is open', async () => {
    const makeSession = (id: string) => ({ id, label: id, workingDirectory: '/x', model: 'opus', color: '#89b4fa', status: 'idle', createdAt: 0, sessionType: 'local' }) as any
    useSessionStore.setState({ sessions: [makeSession('s1'), makeSession('s2')], activeSessionId: 's1' } as any)
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, keyboardShortcuts: DEFAULT_SHORTCUTS } as any })
    useAppMetaStore.setState({ meta: { onboardingCompletedVersion: ONBOARDING_VERSION, completedSteps: Object.fromEntries(STEPS.map((s) => [s.id, '2.1.0'])) } })
    function Shortcuts() {
      const active = useSessionStore((s) => s.activeSessionId)
      useKeyboardShortcuts(active, () => {}, () => {}, 'sessions', [], () => {})
      return null
    }
    await render(h(Shortcuts))
    const ctrlTab = () => key('Tab', { ctrlKey: true })
    for (const open of ['takeover', 'replay'] as const) {
      useHelloCodexStore.setState({ open })
      await ctrlTab()
      expect(useSessionStore.getState().activeSessionId, open).toBe('s1')
    }
    useHelloCodexStore.setState({ open: null })
    await ctrlTab()
    expect(useSessionStore.getState().activeSessionId).toBe('s2')
    // The sidebar's New config shortcut is held the same way.
    expect(src('src/renderer/components/Sidebar.tsx')).toMatch(/if \(deriveOnboarding\(useAppMetaStore\.getState\(\)\.meta, \{\}\)\.due\) return\s*\/\/ And while the Codex introduction covers it \(WP2 commit 6f\)\.\s*if \(useHelloCodexStore\.getState\(\)\.open !== null\) return/)
  })

  it('A4: inside onboarding, Back on its first page returns to the page before, unstamped', async () => {
    const onComplete = vi.fn()
    useAppMetaStore.setState({ meta: { lastSeenVersion: '2.1.0' } })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true } })
    useProviderAccountsStore.setState({ snapshot: withCodex(), loaded: true })
    noteClaudeMissingAtSetup()
    await render(h(OnboardingHarness, { onComplete, codexSetupOnly: true }))
    await click('stub-next')
    expect(byTest('hello-codex')).not.toBeNull()
    expect(heading()).toBe('Hello, Codex')
    await click('hc-back')
    expect(byTest('hello-codex')).toBeNull()
    expect(byTest('page')!.getAttribute('data-page')).toBe('codexSetup')
    expect(seen()).toBeUndefined()
    expect(onComplete).not.toHaveBeenCalled()
    // Still due, so Next shows it again from page 1.
    await click('stub-next')
    expect(heading()).toBe('Hello, Codex')
    // Back past page 1 inside it is page navigation, not leaving.
    await click('hc-primary')
    await click('hc-back')
    expect(heading()).toBe('Hello, Codex')
    // A bare introduction (the takeover) has no Back on page 1.
    remount()
    await render(h(HelloCodex, { onFinish: vi.fn() }))
    expect(byTest('hc-back')).toBeNull()
  })

  it('A5: "Start a Codex session" waits for the resume prompt to be answered before opening New saved config', async () => {
    const start = vi.fn()
    let request: () => void = () => {}
    function Holder({ resumePending }: { resumePending: boolean }) {
      request = useHeldCodexSessionStart(resumePending, start)
      return null
    }
    await render(h(Holder, { resumePending: true }))
    await act(async () => { request() })
    expect(start).not.toHaveBeenCalled()
    // Answered (resumed, or declined): it opens now, once.
    await render(h(Holder, { resumePending: false }))
    expect(start).toHaveBeenCalledTimes(1)
    await render(h(Holder, { resumePending: false }))
    expect(start).toHaveBeenCalledTimes(1)
    // Nothing waiting: straight away.
    await act(async () => { request() })
    expect(start).toHaveBeenCalledTimes(2)
    // App holds the harness's request and the host's through it.
    const app = src('src/renderer/App.tsx')
    expect(app).toContain('const requestCodexSession = useHeldCodexSessionStart(pendingRestore !== null, startCodexSession)')
    expect(app).toContain('if (extra?.startCodexSession) requestCodexSession()')
    expect(app).toContain('onStartSession={requestCodexSession}')
  })
})
