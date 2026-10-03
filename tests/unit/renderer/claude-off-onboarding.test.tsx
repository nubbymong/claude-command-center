// @vitest-environment jsdom
/**
 * P3.4 (row 14): with Claude Code off (Codex-only mode) the onboarding pages
 * make no Claude prompts. Each rule mirrors what the same page already does
 * for Codex while Codex is off:
 *  - Built-in Tools: the heading asks about your sessions, not Claude; Claude
 *    review is blocked (it runs Claude Code) as Codex review is while Codex
 *    is off; Codex review, asked for only from Claude sessions, keeps its
 *    switch with a note, as Claude review does while Codex is off.
 *  - Transparency recap: the Account row (Claude's account) reads OD27's D5
 *    line and no Claude sign-in is read for it (no call); Claude review is
 *    counted only while Claude Code is on, as Codex review is only while
 *    Codex is on.
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

const apState = { profiles: [{ isPrimary: true, accountEmail: 'me@example.com' }] as { isPrimary?: boolean; accountEmail?: string }[], hydrate: vi.fn() }
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => {
  const hook: any = (sel?: (s: typeof apState) => unknown) => (sel ? sel(apState) : apState)
  hook.getState = () => apState
  return { useAccountProfilesStore: hook }
})

const { BuiltinToolsStep } = await import('../../../src/renderer/onboarding/BuiltinToolsStep')
const { TransparencyStep } = await import('../../../src/renderer/onboarding/TransparencyStep')
const { useSettingsStore, DEFAULT_SETTINGS, DEFAULT_CONDUCTOR_TOOLS } = await import('../../../src/renderer/stores/settingsStore')

const D5_LINE = 'Claude Code is off. Turn it on in Settings, Accounts to see its accounts.'
const CODEX_ONLY = { claudeEnabled: false, codexEnabled: true, codexAnswered: true }

const updateSettings = vi.fn(() => Promise.resolve())
function setSettings(over: Record<string, unknown>): void {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS }, ...over } as typeof DEFAULT_SETTINGS, updateSettings } as never)
}

let container: HTMLDivElement
let root: Root
let globalEmail: ReturnType<typeof vi.fn>

beforeEach(() => {
  globalEmail = vi.fn(() => Promise.resolve('me@example.com'))
  ;(window as any).electronAPI = { ...((window as any).electronAPI ?? {}), accountProfiles: { globalEmail } }
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

describe('Built-in Tools step with Claude Code off', () => {
  const renderStep = () => act(() => { root.render(React.createElement(BuiltinToolsStep, { onNext: () => {}, onBack: () => {} })) })

  it('asks about your sessions, not Claude', () => {
    setSettings(CODEX_ONLY)
    renderStep()
    expect(container.querySelector('.h2')!.textContent).toBe('Want your sessions to have a few extra tools?')
    expect(container.querySelector('.p2-sub')!.textContent).not.toContain('Claude')
    // Claude Code on: the page as it was.
    setSettings({ codexEnabled: true })
    renderStep()
    expect(container.querySelector('.h2')!.textContent).toBe('Want Claude to have a few extra tools?')
    expect(container.querySelector('.p2-sub')!.textContent).toContain('Choose which ones Claude gets.')
  })

  it('blocks Claude review (it runs Claude Code), the way Codex review is blocked while Codex is off', () => {
    setSettings(CODEX_ONLY)
    renderStep()
    const c = card('Claude review')
    expect(c.className).toContain('blocked')
    expect(c.hasAttribute('inert')).toBe(true)
    expect(c.querySelector('.gh-tag')?.textContent).toBe('Claude Code off')
    expect(c.querySelector('.tc-d')?.textContent).toBe('Code review is powered by Claude Code, which is turned off. Turn it on in Settings, Accounts.')
    expect((c.querySelector('button.tc-sw') as HTMLButtonElement).className).not.toContain('on')
    expect(c.querySelector('.tc-note')).toBeNull()
  })

  it('keeps Codex review a live switch with a note, the way Claude review is kept while Codex is off', async () => {
    setSettings(CODEX_ONLY)
    renderStep()
    const c = card('Codex review')
    expect(c.className).not.toContain('blocked')
    expect(c.querySelector('.tc-note')?.textContent).toBe('Only Claude sessions use it; Claude Code is off.')
    const button = c.querySelector('button.tc-sw') as HTMLButtonElement
    expect(button.className).toContain('on')
    await act(async () => { button.click() })
    expect(updateSettings).toHaveBeenCalledWith({ conductorTools: { ...DEFAULT_CONDUCTOR_TOOLS, codexReview: false } })
    // Claude Code on: no such note.
    setSettings({ codexEnabled: true })
    renderStep()
    expect(card('Codex review').querySelector('.tc-note')).toBeNull()
    expect(card('Claude review').className).not.toContain('blocked')
  })
})

describe('Transparency recap with Claude Code off', () => {
  const renderStep = async () => {
    await act(async () => { root.render(React.createElement(TransparencyStep, { onNext: () => {}, onBack: () => {} })) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
  }
  const row = (label: string) => [...container.querySelectorAll('.gh-card')].find((x) => x.querySelector('.gh-t')?.textContent === label)?.querySelector('.gh-d')?.textContent ?? ''

  it("reads OD27's D5 line in the Account row, and reads no Claude sign-in for it", async () => {
    setSettings(CODEX_ONLY)
    await renderStep()
    expect(row('Account')).toBe(D5_LINE)
    expect(container.textContent).not.toContain('me@example.com')
    expect(globalEmail).not.toHaveBeenCalled()
  })

  it('names the Claude account while Claude Code is on (the page as it was)', async () => {
    setSettings({ codexEnabled: true })
    await renderStep()
    expect(row('Account')).toBe('me@example.com')
    expect(globalEmail).toHaveBeenCalled()
  })

  it('counts Claude review only while Claude Code is on', async () => {
    setSettings(CODEX_ONLY)
    await renderStep()
    expect(row('Built-in Tools')).toBe('On: 4 of 5 tools (Vision, Codex review, Host screenshots, Agent Canvas)')
  })
})
