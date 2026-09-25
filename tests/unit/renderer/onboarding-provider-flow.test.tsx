// @vitest-environment jsdom
/**
 * WP2 commit 6e: the onboarding pages follow the assistants choice.
 *
 * Drives the REAL harness and the REAL assistants page (main's switch
 * mocked); every other page is a stand-in that shows its id, so what is
 * under test is which pages the harness walks, forwards and back.
 *
 * Verifies:
 *   - fresh install, each choice: Claude only has no Codex setup; Codex only
 *     skips findClaude, compatibility, accounts and statusline and keeps the
 *     rest; Both has everything; the legacy Codex pages are gone;
 *   - the pages are decided when the choice is made: going Back to the
 *     assistants page and choosing again changes what follows;
 *   - upgraders never see assistants or codexSetup: not in a full re-walk
 *     (whatever their providers), not in the release-notes run;
 *   - except (review fix) the upgrader who chose "Use Codex only" on this
 *     run's version-change setup screen: handed exactly the Codex setup page,
 *     once, alone or inside the run that is due, never the assistants page,
 *     settling nothing on its own, and not again on a later start;
 *   - stepping aside for a terminal keeps the page and shows the way back,
 *     and each return is counted for the page.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

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

const ok = () => Promise.resolve({ ok: true })
const setEnabled = vi.fn(ok)
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, providerAccounts: { setEnabled } }
;(globalThis as any).window.electronPlatform = 'win32'

const { OnboardingHarness } = await import('../../../src/renderer/onboarding/OnboardingHarness')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useAppMetaStore } = await import('../../../src/renderer/stores/appMetaStore')
const { resetProviderChoiceForTests, noteClaudeMissingAtSetup } = await import('../../../src/renderer/onboarding/provider-choice')
const settle = await import('../../../src/renderer/onboarding/settle')

let container: HTMLDivElement
let root: Root
const onComplete = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  setEnabled.mockReset()
  setEnabled.mockImplementation(ok)
  onComplete.mockReset()
  vi.mocked(settle.settleWhatsNewOnly).mockClear()
  resetProviderChoiceForTests()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
  useAppMetaStore.setState({ meta: {} })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const byTest = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null

function page(): string {
  if (byTest('assistants-cards')) return 'assistants'
  return byTest('page')?.getAttribute('data-page') ?? '(none)'
}

async function mount(whatsNewOnly = false, codexSetupOnly = false) {
  await act(async () => { root.render(<OnboardingHarness onComplete={onComplete} whatsNewOnly={whatsNewOnly} codexSetupOnly={codexSetupOnly} />) })
}

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve() })
}

async function next() {
  await act(async () => { byTest('stub-next')!.click() })
}

async function back() {
  if (byTest('assistants-cards')) {
    await act(async () => { (container.querySelector('.foot .back') as HTMLElement).click() })
  } else {
    await act(async () => { byTest('stub-back')!.click() })
  }
}

async function choose(choice: 'claude' | 'codex' | 'both') {
  await act(async () => { byTest(`assistants-card-${choice}`)!.click() })
  await act(async () => { byTest('assistants-continue')!.click() })
  await flush()
}

/** Every page from here to the end, choosing `choice` on the assistants page. */
async function walk(choice: 'claude' | 'codex' | 'both' = 'both'): Promise<string[]> {
  const seen: string[] = []
  for (let i = 0; i < 30; i++) {
    const id = page()
    seen.push(id)
    if (id === 'finish' || id === '(none)') return seen
    if (id === 'assistants') await choose(choice)
    else await next()
  }
  throw new Error(`no end: ${seen.join(' > ')}`)
}

const CLAUDE_PAGES = ['findClaude', 'compatibility', 'accounts', 'statusline']

describe('fresh install: the pages follow the assistants choice', () => {
  it('Both: everything, Codex setup after the Claude account page', async () => {
    await mount()
    expect(await walk('both')).toEqual([
      'welcome', 'whatsNewV2Fresh', 'assistants', 'commandBar', 'findClaude', 'compatibility', 'accounts',
      'codexSetup', 'github', 'statusline', 'builtinTools', 'transparency', 'finish',
    ])
  })

  it('Claude Code only: no Codex setup', async () => {
    await mount()
    expect(await walk('claude')).toEqual([
      'welcome', 'whatsNewV2Fresh', 'assistants', 'commandBar', 'findClaude', 'compatibility', 'accounts',
      'github', 'statusline', 'builtinTools', 'transparency', 'finish',
    ])
  })

  it('Codex only: no findClaude, compatibility, accounts or statusline; the rest stays', async () => {
    await mount()
    expect(await walk('codex')).toEqual([
      'welcome', 'whatsNewV2Fresh', 'assistants', 'commandBar', 'codexSetup', 'github', 'builtinTools', 'transparency', 'finish',
    ])
  })

  it('after "Use Codex only" at setup: Codex is the only choice, and the flow is the Codex one', async () => {
    noteClaudeMissingAtSetup()
    await mount()
    await next() // welcome
    await next() // whatsNewV2Fresh
    expect(page()).toBe('assistants')
    expect(byTest('assistants-card-codex')!.getAttribute('aria-checked')).toBe('true')
    await act(async () => { byTest('assistants-continue')!.click() })
    await flush()
    const rest = await walk()
    expect(rest).toEqual(['commandBar', 'codexSetup', 'github', 'builtinTools', 'transparency', 'finish'])
  })

  it('the legacy "Do you use Codex?" and Codex sign-in pages are never shown', async () => {
    for (const choice of ['both', 'claude', 'codex'] as const) {
      useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
      await mount()
      const seen = await walk(choice)
      expect(seen).not.toContain('codex')
      expect(seen).not.toContain('codexSignIn')
      act(() => { root.unmount() })
      root = createRoot(container)
    }
  })

  it('pages are decided when the choice is made: Back and choosing again changes what follows', async () => {
    await mount()
    await next() // welcome
    await next() // whatsNewV2Fresh
    await choose('codex')
    await next() // commandBar
    expect(page()).toBe('codexSetup')
    // Back past the pages Codex only skipped: straight to commandBar.
    await back()
    expect(page()).toBe('commandBar')
    await back()
    expect(page()).toBe('assistants')
    // The page shows the choice already saved.
    expect(byTest('assistants-card-codex')!.getAttribute('aria-checked')).toBe('true')
    await choose('both')
    await next() // commandBar
    expect(page()).toBe('findClaude')
    await back()
    expect(page()).toBe('commandBar')
    await next()
    await next()
    await next()
    await next()
    expect(page()).toBe('codexSetup')
  })
})

describe('upgraders are never asked', () => {
  it('a full re-walk has no assistants page and no Codex setup, even with Codex on', async () => {
    useAppMetaStore.setState({ meta: { lastSeenVersion: '2.0.4' } })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, codexEnabled: true } })
    await mount()
    expect(await walk()).toEqual([
      'whatsNewV2', 'welcome', 'commandBar', 'findClaude', 'compatibility', 'accounts',
      'github', 'statusline', 'builtinTools', 'transparency', 'finish',
    ])
  })

  it('an upgrader who turned Claude Code off in Settings skips its pages, and still gets no Codex setup', async () => {
    useAppMetaStore.setState({ meta: { lastSeenVersion: '2.1.0' } })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true } })
    await mount()
    const seen = await walk()
    for (const id of CLAUDE_PAGES) expect(seen).not.toContain(id)
    expect(seen).not.toContain('assistants')
    expect(seen).not.toContain('codexSetup')
  })

  it('the release-notes run shows the notes and the pages new since, never the choice or Codex setup', async () => {
    useAppMetaStore.setState({ meta: { lastSeenVersion: '2.1.0-beta.15' } })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, codexEnabled: true } })
    await mount(true)
    expect(page()).toBe('whatsNewV2')
    await next()
    expect(page()).toBe('commandBar')
    await next()
    // The last page's CTA ends the run.
    expect(settle.settleWhatsNewOnly).toHaveBeenCalledTimes(1)
    expect(onComplete).toHaveBeenCalledWith(false)
  })

  it('from 2.1.0, the notes run is the notes alone', async () => {
    useAppMetaStore.setState({ meta: { lastSeenVersion: '2.1.0' } })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true } })
    await mount(true)
    expect(page()).toBe('whatsNewV2')
    await next()
    expect(onComplete).toHaveBeenCalledWith(false)
  })
})

describe('an upgrader who chose "Use Codex only" on the version-change setup screen', () => {
  const codexOnly = () => {
    useAppMetaStore.setState({ meta: { lastSeenVersion: '2.1.0' } })
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, claudeEnabled: false, codexEnabled: true } })
  }
  const newBadge = () => container.querySelector('.ob-new')

  beforeEach(() => {
    vi.mocked(settle.settleOnboardingFinish).mockClear()
  })

  it('nothing else due: exactly the Codex setup page, no Back, no badge, and its Next ends the run stamping nothing', async () => {
    codexOnly()
    noteClaudeMissingAtSetup()
    await mount(false, true)
    expect(page()).toBe('codexSetup')
    expect(byTest('stub-back')).toBeNull()
    expect(newBadge()).toBeNull()
    await next()
    expect(onComplete).toHaveBeenCalledWith(false)
    expect(settle.settleWhatsNewOnly).not.toHaveBeenCalled()
    expect(settle.settleOnboardingFinish).not.toHaveBeenCalled()
  })

  it('with the release notes due: the notes, then the Codex setup page, unbadged; never the assistants page', async () => {
    codexOnly()
    noteClaudeMissingAtSetup()
    await mount(true)
    expect(page()).toBe('whatsNewV2')
    await next()
    expect(page()).toBe('codexSetup')
    expect(newBadge()).toBeNull()
    await next()
    expect(onComplete).toHaveBeenCalledWith(false)
    expect(settle.settleWhatsNewOnly).toHaveBeenCalledTimes(1)
  })

  it('in a full re-walk: the Codex setup page, never the assistants page or the Claude Code pages', async () => {
    codexOnly()
    noteClaudeMissingAtSetup()
    await mount()
    const seen = await walk()
    expect(seen.filter((id) => id === 'codexSetup')).toEqual(['codexSetup'])
    expect(seen).not.toContain('assistants')
    for (const id of CLAUDE_PAGES) expect(seen).not.toContain(id)
  })

  it('an upgrader who did not choose it gets no Codex page, whatever their providers', async () => {
    codexOnly()
    await mount(true)
    expect(page()).toBe('whatsNewV2')
    await next()
    expect(onComplete).toHaveBeenCalledWith(false)
    act(() => { root.unmount() })
    root = createRoot(container)
    const seen = await (async () => { await mount(); return walk() })()
    expect(seen).not.toContain('codexSetup')
  })

  it('a later start (a new renderer: the in-memory choice is gone) does not show it again', async () => {
    codexOnly()
    noteClaudeMissingAtSetup()
    resetProviderChoiceForTests()
    await mount(true)
    expect(page()).toBe('whatsNewV2')
    await next()
    expect(onComplete).toHaveBeenCalledWith(false)
  })

  it('a fresh install is unchanged: the assistants page, then Codex setup', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
    noteClaudeMissingAtSetup()
    await mount()
    const seen = await walk()
    expect(seen).toEqual(['welcome', 'whatsNewV2Fresh', 'assistants', 'commandBar', 'codexSetup', 'github', 'builtinTools', 'transparency', 'finish'])
  })
})

describe('stepping aside for a terminal', () => {
  it('hides the pages, keeps the one the user left, and counts the return', async () => {
    await mount()
    await next() // welcome
    await next() // whatsNewV2Fresh
    await choose('codex')
    await next() // commandBar
    expect(page()).toBe('codexSetup')
    const obRoot = container.querySelector('.ob-root') as HTMLElement
    expect(obRoot.style.display).toBe('')
    expect(byTest('onboarding-back-to-setup')).toBeNull()

    await act(async () => { byTest('stub-step-aside')!.click() })
    expect(obRoot.style.display).toBe('none')
    expect(byTest('onboarding-back-to-setup')).not.toBeNull()
    expect(byTest('page')!.getAttribute('data-returns')).toBe('0')

    await act(async () => { byTest('onboarding-back-to-setup-button')!.click() })
    expect(obRoot.style.display).toBe('')
    expect(byTest('onboarding-back-to-setup')).toBeNull()
    expect(page()).toBe('codexSetup')
    expect(byTest('page')!.getAttribute('data-returns')).toBe('1')
  })
})
