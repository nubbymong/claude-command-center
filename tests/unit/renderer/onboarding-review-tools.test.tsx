// @vitest-environment jsdom
/**
 * Onboarding and the two review directions (WP2 commit 6): the Built-in
 * tools step lists Claude review beside Codex review and toggles its own
 * key; both are blocked while Codex is off (the stored choice is left
 * alone); the Transparency recap names claude_review among the tools it
 * says are on.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ghState = { profiles: [] as { username: string }[], config: { enabledByDefault: false }, loadConfig: vi.fn() }
vi.mock('../../../src/renderer/stores/githubStore', () => {
  const hook: any = (sel?: (s: typeof ghState) => unknown) => (sel ? sel(ghState) : ghState)
  hook.getState = () => ghState
  return { useGitHubStore: hook }
})

const apState = { profiles: [] as { isPrimary?: boolean; accountEmail?: string }[], hydrate: vi.fn() }
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => {
  const hook: any = (sel?: (s: typeof apState) => unknown) => (sel ? sel(apState) : apState)
  hook.getState = () => apState
  return { useAccountProfilesStore: hook }
})

const { BuiltinToolsStep } = await import('../../../src/renderer/onboarding/BuiltinToolsStep')
const { TransparencyStep } = await import('../../../src/renderer/onboarding/TransparencyStep')
const { CodexStep } = await import('../../../src/renderer/onboarding/CodexStep')
const { useCodexAccountStore } = await import('../../../src/renderer/stores/codexAccountStore')
const { useSettingsStore, DEFAULT_SETTINGS, DEFAULT_CONDUCTOR_TOOLS } = await import('../../../src/renderer/stores/settingsStore')

const updateSettings = vi.fn(() => Promise.resolve())
function setSettings(over: Record<string, unknown>): void {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, ...over } as typeof DEFAULT_SETTINGS, updateSettings } as never)
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(window as any).electronAPI = { ...((window as any).electronAPI ?? {}), accountProfiles: { globalEmail: vi.fn(() => Promise.resolve(null)) } }
  updateSettings.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const card = (title: string): HTMLElement => {
  const el = [...container.querySelectorAll<HTMLElement>('.tool-card')].find((c) => c.querySelector('.tc-t')?.firstChild?.textContent === title)
  if (!el) throw new Error(`no tool card titled "${title}"`)
  return el
}

describe('Built-in tools step', () => {
  const renderStep = () => act(() => { root.render(React.createElement(BuiltinToolsStep, { onNext: () => {}, onBack: () => {} })) })

  it('lists Claude review beside Codex review, each with its own direction', () => {
    setSettings({})
    renderStep()
    const titles = [...container.querySelectorAll('.tool-card .tc-t')].map((t) => t.firstChild?.textContent)
    expect(titles.indexOf('Claude review')).toBe(titles.indexOf('Codex review') + 1)
    expect(card('Codex review').querySelector('.tc-d')?.textContent).toContain('Claude sessions can ask Codex to review')
    expect(card('Claude review').querySelector('.tc-d')?.textContent).toContain('Codex sessions can ask Claude to review')
  })

  it('toggles claudeReview over the defaults, and leaves codexReview alone', async () => {
    setSettings({ conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS } })
    renderStep()
    const button = card('Claude review').querySelector('button.tc-sw') as HTMLButtonElement
    expect(button.className).toContain('on')
    await act(async () => { button.click() })
    expect(updateSettings).toHaveBeenCalledWith({ conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS, claudeReview: false } })
  })

  it('blocks Codex review while Codex is off, and points at Settings, Accounts', () => {
    setSettings({ codexEnabled: false })
    renderStep()
    const c = card('Codex review')
    expect(c.className).toContain('blocked')
    expect(c.hasAttribute('inert')).toBe(true)
    expect(c.querySelector('.gh-tag')?.textContent).toBe('Codex off')
    expect((c.querySelector('button.tc-sw') as HTMLButtonElement).className).not.toContain('on')
    expect(c.querySelector('.tc-d')?.textContent).toBe('Code review is powered by Codex, which is turned off. Turn it on from the Codex page, or in Settings, Accounts.')
    // Vision is not a Codex tool: never blocked by it.
    expect(card('Vision: see & drive a browser').className).not.toContain('blocked')
  })

  it('keeps Claude review a live switch while Codex is off, with a note', async () => {
    setSettings({ codexEnabled: false, conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS } })
    renderStep()
    const c = card('Claude review')
    expect(c.className).not.toContain('blocked')
    expect(c.hasAttribute('inert')).toBe(false)
    expect(c.querySelector('.tc-note')?.textContent).toBe('Only Codex sessions use it; Codex is off.')
    const button = c.querySelector('button.tc-sw') as HTMLButtonElement
    expect(button.className).toContain('on')
    await act(async () => { button.click() })
    expect(updateSettings).toHaveBeenCalledWith({ conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS, claudeReview: false } })
  })

  it('shows no Codex-off note while Codex is on', () => {
    setSettings({})
    renderStep()
    expect(card('Claude review').querySelector('.tc-note')).toBeNull()
  })
})

describe('Transparency recap', () => {
  const renderStep = () => act(() => { root.render(React.createElement(TransparencyStep, { onNext: () => {}, onBack: () => {} })) })
  const toolsValue = () => {
    const c = [...container.querySelectorAll('.gh-card')].find((x) => x.querySelector('.gh-t')?.textContent === 'Built-in tools')
    return c?.querySelector('.gh-d')?.textContent ?? ''
  }

  it('discloses Claude review among the tools that are on', () => {
    setSettings({})
    renderStep()
    expect(toolsValue()).toBe('On: 5 of 5 tools (Vision, Codex review, Claude review, Host screenshots, Agent Canvas)')
  })

  it('leaves Claude review out only when its own switch is off; Codex off leaves out Codex review alone', () => {
    setSettings({ conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS, claudeReview: false } })
    renderStep()
    expect(toolsValue()).toBe('On: 4 of 5 tools (Vision, Codex review, Host screenshots, Agent Canvas)')
    act(() => { root.unmount() })
    root = createRoot(container)
    setSettings({ codexEnabled: false })
    renderStep()
    expect(toolsValue()).toBe('On: 4 of 5 tools (Vision, Claude review, Host screenshots, Agent Canvas)')
  })

  it('points at Settings, Accounts to turn Codex on', () => {
    setSettings({ codexEnabled: false })
    renderStep()
    const c = [...container.querySelectorAll('.gh-card')].find((x) => x.querySelector('.gh-t')?.textContent === 'Codex (Beta)')
    expect(c?.querySelector('.gh-d')?.textContent).toBe('Off (Settings, Accounts)')
  })
})

describe('Codex step', () => {
  it('points at Settings, Accounts to turn Codex on later', () => {
    useCodexAccountStore.setState({ installed: false, refresh: vi.fn(() => Promise.resolve()) } as never)
    setSettings({ codexEnabled: false })
    act(() => { root.render(React.createElement(CodexStep, { onNext: () => {}, onBack: () => {} })) })
    expect(container.textContent).toContain('Enable it anytime in Settings, Accounts.')
    expect(container.textContent).not.toContain('Settings → Codex')
  })
})
