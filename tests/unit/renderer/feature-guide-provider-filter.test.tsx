// @vitest-environment jsdom
/**
 * [host] P4.11 (row 14, Codex-only mode with no Claude noise; PR 3 gate 6's
 * observation): the Feature Guide and the Feature tour show the cards for the
 * assistants in use, each with its copy for that mode.
 *
 * Verifies:
 *   - a card about something only Claude Code has in this release (Dynamic
 *     Workflows, Multiple Accounts (Insights until P4.7 lifted it), and Code review, which
 *     needs both) is not shown while Codex is the only assistant in use; with
 *     Claude Code alone only Code review goes, and the Codex card stays, as
 *     What's New shows its Codex lines (P4.11 review, P411-2); with both on
 *     every card shows, as written;
 *   - with Codex alone, no line a shown card holds names Claude unless it
 *     names Codex too (a line about both assistants), and the cards that hold
 *     Claude-only lines show their copy for that mode;
 *   - the guide page's sections, rail counts and search follow the filter, and
 *     so does the Feature tour;
 *   - the Ask card names the assistant Ask runs on.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
;(window as any).electronPlatform = 'win32'

const { trainingSteps, stepsForAssistants } = await import('../../../src/renderer/training-steps')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useProviderAccountsStore } = await import('../../../src/renderer/stores/providerAccountsStore')
const { useAppMetaStore } = await import('../../../src/renderer/stores/appMetaStore')
const { default: FeatureGuidePage } = await import('../../../src/renderer/components/FeatureGuidePage')
const { default: TrainingWalkthrough } = await import('../../../src/renderer/components/TrainingWalkthrough')
const { snapshot } = await import('./accounts-snapshot-harness')

const { choiceSettings, onlyAssistantInUse } = await import('../../../src/renderer/onboarding/provider-choice')
// The saved switches for each choice, as Settings saves them.
const CODEX_ONLY = choiceSettings('codex')
const CLAUDE_ONLY = choiceSettings('claude')
const BOTH = choiceSettings('both')
/** The cards shown for the switches `s`, as the guide and the tour read them. */
const shownFor = (s: typeof BOTH) => stepsForAssistants(trainingSteps, onlyAssistantInUse(s))

const ids = (s: { id: string }[]) => s.map((x) => x.id)

/** Every line of text a card shows. */
function lines(step: (typeof trainingSteps)[number]): string[] {
  return [step.title, step.summary ?? '', ...(step.highlights ?? []), ...(step.bullets ?? []), ...(step.howToTrigger ?? []).map((h) => `${h.label}: ${h.value}`), step.proTip ?? ''].filter(Boolean)
}

describe('stepsForAssistants', () => {
  it('both on: every card, as written', () => {
    expect(shownFor(BOTH)).toEqual(trainingSteps)
  })

  it('Codex alone: the Claude-only cards go, the Codex card stays', () => {
    const shown = ids(shownFor(CODEX_ONLY))
    for (const id of ['dynamic-workflows', 'multi-account', 'code-review']) expect(shown, id).not.toContain(id)
    for (const id of ['codex-provider', 'provider-accounts', 'ask-conductor', 'vision', 'agent-canvas', 'excalidraw', 'snap', 'memory-visualiser', 'settings', 'insights']) expect(shown, id).toContain(id)
  })

  it('Claude Code alone: only Code review goes (it needs both); the Codex card stays, as before', () => {
    const shown = ids(shownFor(CLAUDE_ONLY))
    expect(shown).toContain('codex-provider')
    expect(shown).not.toContain('code-review')
    expect(shown).toEqual(ids(trainingSteps).filter((id) => id !== 'code-review'))
    // Claude Code alone shows each card as written.
    for (const s of shownFor(CLAUDE_ONLY)) expect(s).toBe(trainingSteps.find((t) => t.id === s.id))
  })

  it('Codex alone: no line names Claude unless it names Codex too', () => {
    const noisy = shownFor(CODEX_ONLY).flatMap((s) => lines(s).filter((l) => /Claude/.test(l) && !/Codex/.test(l)).map((l) => `${s.id}: ${l}`))
    expect(noisy).toEqual([])
  })

  it('Codex alone: the cards with Claude-only lines show their copy for that mode', () => {
    const shown = shownFor(CODEX_ONLY)
    const text = (id: string) => lines(shown.find((s) => s.id === id)!).join('\n')
    expect(text('session-options')).not.toMatch(/\/effort/)
    expect(text('session-options')).toMatch(/model pill/)
    expect(text('session-options')).toMatch(/Codex sessions run on this computer only/)
    expect(text('settings')).not.toMatch(/dynamic workflows/i)
    expect(text('tips')).not.toMatch(/over SSH, it asks/)
    expect(text('vision')).not.toMatch(/SSH|reverse tunnel/i)
    // The written card is unchanged for the other modes.
    expect(lines(trainingSteps.find((s) => s.id === 'session-options')!).join('\n')).toMatch(/\/effort/)
  })

  it('the cards whose feature now works for both read for both in every mode (P4.1, P4.2, P4.4)', () => {
    const text = (id: string) => lines(trainingSteps.find((s) => s.id === id)!).join('\n')
    expect(text('vision')).not.toMatch(/every Claude session|exposed to Claude|available to Claude|Ask Claude/)
    expect(text('vision')).toMatch(/Claude and Codex sessions/)
    expect(text('excalidraw')).not.toMatch(/Claude/)
    expect(text('snap')).not.toMatch(/Claude/)
    expect(text('combined-mode')).not.toMatch(/Claude/)
    expect(text('tokenomics')).not.toMatch(/Opus vs Sonnet vs Haiku/)
    expect(text('memory-visualiser')).toMatch(/each Codex account's own memories/)
  })
})

let container: HTMLDivElement
let root: Root

function setProviders(over: Partial<typeof BOTH>) {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...over }, isLoaded: true })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useProviderAccountsStore.setState({ snapshot: snapshot(), loaded: true })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const guide = async () => {
  await act(async () => { root.render(<FeatureGuidePage onNavigateToSessions={() => {}} onStartTour={() => {}} />) })
}
const railCount = (id: string) => container.querySelector(`[data-ux-id="rail-${id}"]`)?.textContent ?? ''
const cardShown = (id: string) => container.querySelector(`[data-ux-id="card-${id}"]`) !== null
async function open(section: string) {
  const btn = container.querySelector(`[data-ux-id="rail-${section}"]`) as HTMLButtonElement
  await act(async () => { btn.click() })
}
async function search(text: string) {
  const input = container.querySelector('[data-ux-id="search"]') as HTMLInputElement
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  await act(async () => { set.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
}

describe('the Feature Guide page', () => {
  it('Codex alone: Productivity shows no Dynamic Workflows card and its rail count follows', async () => {
    setProviders(CODEX_ONLY)
    await guide()
    const all = trainingSteps.filter((s) => s.section === 'productivity').length
    expect(railCount('productivity')).toContain(String(all - 1))
    await open('productivity')
    expect(cardShown('dynamic-workflows')).toBe(false)
    expect(cardShown('excalidraw')).toBe(true)
    expect(container.querySelector('[data-ux-id="content"]')!.textContent).not.toMatch(/Claude/)
  })

  it('Codex alone: Admin shows the Insights card (P4.7); Getting started no Multiple Accounts card', async () => {
    setProviders(CODEX_ONLY)
    await guide()
    await open('admin')
    expect(cardShown('insights')).toBe(true)
    expect(cardShown('memory-visualiser')).toBe(true)
    await open('getting-started')
    expect(cardShown('multi-account')).toBe(false)
    expect(cardShown('provider-accounts')).toBe(true)
  })

  it('Codex alone: search finds no hidden card', async () => {
    setProviders(CODEX_ONLY)
    await guide()
    await search('workflow')
    expect(cardShown('dynamic-workflows')).toBe(false)
  })

  it('Claude Code alone: Integrations shows the Codex card and no Code review card; both on shows both', async () => {
    setProviders(CLAUDE_ONLY)
    await guide()
    await open('integrations')
    expect(cardShown('codex-provider')).toBe(true)
    expect(cardShown('code-review')).toBe(false)
    expect(container.querySelector('[data-ux-id="section-hero"]')!.textContent).toMatch(/Codex, browser automation, agents, GitHub and the Agent Canvas/)
    act(() => { root.unmount() })
    root = createRoot(container)
    setProviders(BOTH)
    await guide()
    await open('integrations')
    expect(cardShown('codex-provider')).toBe(true)
    expect(cardShown('code-review')).toBe(true)
    await open('productivity')
    expect(cardShown('dynamic-workflows')).toBe(true)
  })

  it('the Ask card names the assistant Ask runs on', async () => {
    const note = () => container.querySelector('[data-ux-id="ask-card"]')!.textContent ?? ''
    setProviders(CODEX_ONLY)
    await guide()
    expect(note()).toContain('Opens a Codex session already primed with this guide')
    expect(note()).toContain('Uses your normal Codex usage.')
    expect(note()).not.toMatch(/Claude/)
    act(() => { root.unmount() })
    root = createRoot(container)
    setProviders(CLAUDE_ONLY)
    await guide()
    expect(note()).toContain('Opens a Claude session already primed with this guide')
    act(() => { root.unmount() })
    root = createRoot(container)
    setProviders({ ...BOTH, askConductorProvider: 'codex' } as never)
    await guide()
    expect(note()).toContain('Opens a Codex session already primed with this guide')
  })
})

describe('the Feature tour', () => {
  it('Codex alone: the tour steps through the cards for Codex only', async () => {
    setProviders(CODEX_ONLY)
    useAppMetaStore.setState({ meta: { ...useAppMetaStore.getState().meta, lastTrainingVersion: '0.0.0' } } as never)
    await act(async () => { root.render(<TrainingWalkthrough onClose={() => {}} showAll mode="help" />) })
    const expected = shownFor(CODEX_ONLY).length
    expect(expected).toBeLessThan(trainingSteps.length)
    expect(document.body.textContent).toContain(`step 1 of ${expected}`)
  })
})
