// @vitest-environment jsdom
/**
 * "Which assistants will you use?" follows the ARIA radio group keyboard
 * pattern (VM audit 2026-09-25, item 6: the arrow keys did nothing, and every
 * card was its own Tab stop).
 *
 * Verifies:
 *   - only the selected card is a Tab stop (tabindex 0; the others -1);
 *   - Right/Down select the next card and move focus to it, Left/Up the
 *     previous, round the ends; the Tab stop follows the selection;
 *   - disabled cards are skipped ("Use Codex only": the arrows stay on Codex);
 *   - other keys, and arrows with a modifier, are left alone.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const setEnabled = vi.fn(async () => ({ ok: true }))
;(globalThis as any).window.electronAPI = { ...(globalThis as any).window.electronAPI, providerAccounts: { setEnabled } }

const { AssistantsStep } = await import('../../../src/renderer/onboarding/AssistantsStep')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { resetProviderChoiceForTests, noteClaudeMissingAtSetup } = await import('../../../src/renderer/onboarding/provider-choice')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  resetProviderChoiceForTests()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const card = (c: string) => container.querySelector(`[data-testid="assistants-card-${c}"]`) as HTMLButtonElement
const checked = () => ['claude', 'codex', 'both'].filter((c) => card(c).getAttribute('aria-checked') === 'true')
const stops = () => ['claude', 'codex', 'both'].filter((c) => card(c).tabIndex === 0)
const focused = () => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid')

async function render() {
  await act(async () => { root.render(<AssistantsStep onNext={vi.fn()} onBack={vi.fn()} />) })
}

async function press(key: string, init: KeyboardEventInit = {}): Promise<boolean> {
  const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  await act(async () => { (document.activeElement as HTMLElement).dispatchEvent(ev) })
  return ev.defaultPrevented
}

describe('the assistants radio group', () => {
  it('only the selected card (Both, the default) is a Tab stop', async () => {
    await render()
    expect(checked()).toEqual(['both'])
    expect(stops()).toEqual(['both'])
    expect(card('claude').tabIndex).toBe(-1)
    expect(card('codex').tabIndex).toBe(-1)
  })

  it('Right and Down select the next card and take focus to it, round the end', async () => {
    await render()
    card('both').focus()
    expect(await press('ArrowRight')).toBe(true)
    expect(checked()).toEqual(['claude'])
    expect(focused()).toBe('assistants-card-claude')
    expect(stops()).toEqual(['claude'])
    await press('ArrowDown')
    expect(checked()).toEqual(['codex'])
    expect(focused()).toBe('assistants-card-codex')
  })

  it('Left and Up select the previous card, round the start', async () => {
    await render()
    card('both').focus()
    await press('ArrowLeft')
    expect(checked()).toEqual(['codex'])
    expect(focused()).toBe('assistants-card-codex')
    await press('ArrowUp')
    expect(checked()).toEqual(['claude'])
    await press('ArrowUp')
    expect(checked()).toEqual(['both'])
    expect(focused()).toBe('assistants-card-both')
    expect(stops()).toEqual(['both'])
  })

  it('skips the cards that cannot be chosen ("Use Codex only": Codex is the only one)', async () => {
    noteClaudeMissingAtSetup()
    await render()
    expect(checked()).toEqual(['codex'])
    expect(stops()).toEqual(['codex'])
    card('codex').focus()
    await press('ArrowRight')
    expect(checked()).toEqual(['codex'])
    expect(focused()).toBe('assistants-card-codex')
    await press('ArrowLeft')
    expect(checked()).toEqual(['codex'])
  })

  it('other keys, and arrows with a modifier, are left alone', async () => {
    await render()
    card('both').focus()
    expect(await press('a')).toBe(false)
    expect(await press('ArrowRight', { ctrlKey: true })).toBe(false)
    expect(await press('ArrowRight', { altKey: true })).toBe(false)
    expect(checked()).toEqual(['both'])
    expect(focused()).toBe('assistants-card-both')
  })
})
