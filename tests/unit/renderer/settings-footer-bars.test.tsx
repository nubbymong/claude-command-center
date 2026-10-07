// @vitest-environment jsdom
//
// Usage track MP6 (the approved canvas, usage footer settings as drawn): the
// Status Line tab's bar toggles read Claude Code's labels from cached figures
// (never a network fetch of every account), and with Codex in use the footer
// has a card per provider, each led by its mark, writing per-provider hidden
// entries (`claude:<label>`, `codex:<label>`). With Claude Code alone its
// footer card reads as it always has. The Codex note shows while Codex is in
// use.
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  updateSettings: (() => Promise.resolve()) as (u: Record<string, unknown>) => Promise<unknown>,
  sessions: [] as Array<Record<string, unknown>>,
}))

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({ sessions: h.sessions, activeSessionId: null }),
}))

vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const DEFAULT_STATUS_LINE = {
    showModel: true, showTokens: true, showContextBar: true, showCost: true, showLinesChanged: true,
    showDuration: true, showRateLimits: true, showResetTime: true, font: 'sans', fontSize: 12,
  }
  const state = () => ({ settings: { statusLine: DEFAULT_STATUS_LINE, ...h.settings }, updateSettings: (u: Record<string, unknown>) => h.updateSettings(u) })
  const useSettingsStore: any = (selector: any) => selector(state())
  useSettingsStore.getState = () => state()
  return {
    DEFAULT_STATUS_LINE,
    DEFAULT_CONDUCTOR_TOOLS: { vision: true, codexReview: true, claudeReview: true, hostTransfer: true, canvas: true },
    useSettingsStore,
  }
})

const knownLabels = vi.fn(async () => ['5h', 'Weekly', 'Fable'])
const fetchAll = vi.fn(async () => [])
;(window as any).electronAPI = {
  debug: { isEnabled: vi.fn().mockResolvedValue(false) },
  accountProfiles: { globalEmail: vi.fn().mockResolvedValue(null) },
  accountUsage: { knownLabels, fetchAll },
}

const { default: SettingsPage } = await import('../../../src/renderer/components/SettingsPage')
const { choiceSettings } = await import('../../../src/renderer/onboarding/provider-choice')

let container: HTMLDivElement
let root: Root
let writes: Array<Record<string, unknown>> = []
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
  writes = []
  h.updateSettings = (u) => { writes.push(u); return Promise.resolve() }
  h.sessions = []
  knownLabels.mockClear(); fetchAll.mockClear()
})
afterEach(() => { act(() => root.unmount()); container.remove() })

async function open(mode: 'claude' | 'codex' | 'both', over: Record<string, unknown> = {}) {
  h.settings = { ...choiceSettings(mode), codexAnswered: true, ...over }
  await act(async () => { root.render(React.createElement(SettingsPage as React.ComponentType<{ initialTab?: string }>, { initialTab: 'statusline' })) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}
const card = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null
const title = (id: string) => card(id)?.querySelector('h3')?.textContent
const marks = (id: string) => Array.from(card(id)?.querySelectorAll('[data-testid^="provider-mark-"]') ?? []).map((m) => m.getAttribute('data-testid'))
const toggles = (id: string) => Array.from(card(id)?.querySelectorAll('button') ?? []) as HTMLElement[]
const labelsOf = (id: string) => Array.from(card(id)?.querySelectorAll('.text-sm.text-text') ?? []).map((l) => l.textContent)
const click = async (el: HTMLElement) => { await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }) }
const MIDDOT = String.fromCharCode(0xb7)

describe('Status Line tab, usage bar toggles (usage track MP6)', () => {
  it('Claude Code alone: labels from cached figures (no network fetch), one footer card as before, no mark', async () => {
    await open('claude')
    expect(knownLabels).toHaveBeenCalledTimes(1)
    expect(fetchAll).not.toHaveBeenCalled()
    expect(title('usage-bars-footer-claude')).toBe('Multi-account footer bars')
    expect(card('usage-bars-footer-claude')?.textContent).toContain('when 2 or more accounts are live')
    expect(marks('usage-bars-footer-claude')).toEqual([])
    expect(card('usage-bars-footer-codex')).toBeNull()
    expect(labelsOf('usage-bars-footer-claude')).toEqual(['5h', 'Weekly', 'Fable'])
    expect(container.querySelector('[data-testid="statusline-codex-note"]')).toBeNull()
  })

  it('hiding a footer bar writes it as Claude Code\'s; showing it again clears the older bare entry too', async () => {
    await open('claude', { footerHiddenUsageBuckets: ['Weekly'] })
    const [fiveH, weekly] = toggles('usage-bars-footer-claude')
    expect(weekly.getAttribute('aria-pressed') ?? weekly.getAttribute('aria-checked')).not.toBe('true')
    await click(fiveH)
    expect(writes.pop()).toEqual({ footerHiddenUsageBuckets: ['Weekly', 'claude:5h'] })
    await click(weekly)
    expect(writes.pop()).toEqual({ footerHiddenUsageBuckets: [] })
  })

  it('both providers: a card per provider, each led by its mark, identities in the wording; Codex from its windows and its live sessions', async () => {
    h.sessions = [{ id: 's1', provider: 'codex', usageBuckets: [{ key: 'codex_spark/300:Spark', label: 'Spark 5h', group: 'session', percent: 1, resetsAt: '', severity: 'normal' }] }]
    await open('both')
    expect(title('usage-bars-footer-claude')).toBe(`Claude Code ${MIDDOT} Multi-account footer bars`)
    expect(card('usage-bars-footer-claude')?.textContent).toContain('when 2 or more identities are live')
    expect(marks('usage-bars-footer-claude')).toEqual(['provider-mark-claude'])
    expect(title('usage-bars-footer-codex')).toBe(`Codex ${MIDDOT} Multi-account footer bars`)
    expect(card('usage-bars-footer-codex')?.textContent).toContain('Discovered from your Codex sessions, so this list follows whatever Codex reports.')
    expect(marks('usage-bars-footer-codex')).toEqual(['provider-mark-codex'])
    expect(labelsOf('usage-bars-footer-codex')).toEqual(['5h', 'Weekly', 'Spark 5h'])
    expect(labelsOf('usage-bars-session')).toEqual(['5h', 'Weekly', 'Fable', 'Spark 5h'])
    expect(container.querySelector('[data-testid="statusline-codex-note"]')?.textContent).toBe(
      'These settings apply to Codex sessions too.',
    )
    const codexWeekly = toggles('usage-bars-footer-codex')[1]
    await click(codexWeekly)
    expect(writes.pop()).toEqual({ footerHiddenUsageBuckets: ['codex:Weekly'] })
  })

  // MP6 review S1: nothing cached yet (a fresh install) beside Codex: Claude
  // Code's card still offers its two windows.
  it('both providers with nothing cached for Claude Code yet: its footer card still offers 5h and Weekly', async () => {
    knownLabels.mockResolvedValueOnce([])
    await open('both')
    expect(labelsOf('usage-bars-footer-claude')).toEqual(['5h', 'Weekly'])
    expect(labelsOf('usage-bars-footer-codex')).toEqual(['5h', 'Weekly'])
  })

  it('Codex alone (Claude Code off): only the Codex card, and nothing of Claude Code is asked for', async () => {
    await open('codex')
    expect(knownLabels).not.toHaveBeenCalled()
    expect(card('usage-bars-footer-claude')).toBeNull()
    expect(labelsOf('usage-bars-footer-codex')).toEqual(['5h', 'Weekly'])
  })

  it('a Codex footer entry never hides a Claude Code bar, nor a Claude Code one a Codex bar', async () => {
    await open('both', { footerHiddenUsageBuckets: ['codex:Weekly', 'claude:5h'] })
    const pressed = (id: string) => toggles(id).map((b) => b.getAttribute('aria-pressed') ?? b.getAttribute('aria-checked'))
    expect(pressed('usage-bars-footer-claude')).toEqual(['false', 'true', 'true'])
    expect(pressed('usage-bars-footer-codex')).toEqual(['true', 'false'])
  })
})
