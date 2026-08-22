// @vitest-environment jsdom
/**
 * The one-row command bar's welcome page (#382, ADR-018): shown once to every
 * existing user on the first launch after the upgrade, and to fresh installs in
 * the full flow. It says how many of THEIR buttons were tagged for review on
 * this launch and where to go -- nothing was changed for them, and the page
 * must not pretend otherwise.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let COMMANDS: Array<{ id: string; needsReview?: string[] }> = []
vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: (sel: (s: { commands: typeof COMMANDS }) => unknown) => sel({ commands: COMMANDS }),
}))

const { CommandBarStep } = await import('../../../src/renderer/onboarding/CommandBarStep')

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); COMMANDS = [] })
afterEach(() => { act(() => { root.unmount() }); container.remove() })

const render = (props: { onNext: () => void; onBack?: () => void }) => act(() => { root.render(React.createElement(CommandBarStep, props)) })
const byUx = (id: string) => container.querySelector<HTMLElement>(`[data-ux-id="${id}"]`)

describe('the command-bar welcome page', () => {
  it('names the change in one headline and a handful of one-line items, grouped', () => {
    render({ onNext: vi.fn() })
    expect(byUx('commandbar-heading')!.textContent).toBe('The command bar is one row')
    const sections = Array.from(byUx('commandbar-sections')!.querySelectorAll('section'))
    expect(sections.length).toBe(3)
    const items = byUx('commandbar-sections')!.querySelectorAll('.wn-item')
    expect(items.length).toBeGreaterThanOrEqual(6)
    expect(byUx('commandbar-sub')!.textContent).toContain(`${items.length} things to know`)
    expect(byUx('commandbar-sub')!.textContent).toContain('Nothing you had was changed')
  })

  it('tells the user how many of THEIR buttons carry the review mark, and where to look', () => {
    COMMANDS = [{ id: 'a', needsReview: ['secret-like-arg'] }, { id: 'b' }, { id: 'c', needsReview: ['section-dissolved'] }]
    render({ onNext: vi.fn() })
    const p = byUx('commandbar-review')!
    expect(p.dataset.reviewCount).toBe('2')
    expect(p.textContent).toContain('2 of your existing buttons carry an amber mark')
    expect(p.textContent).toContain('Review 2 commands')
    expect(p.textContent).toContain('Settings → Custom Commands')
    expect(p.textContent).toContain('Nothing was changed')
  })

  it('singular when one button needs a look; "nothing to review" when none do', () => {
    COMMANDS = [{ id: 'a', needsReview: ['ssh-partner-is-local'] }]
    render({ onNext: vi.fn() })
    expect(byUx('commandbar-review')!.textContent).toContain('1 of your existing button carries an amber mark')
    expect(byUx('commandbar-review')!.textContent).toContain('Review 1 command')
    act(() => { root.unmount() })
    root = createRoot(container)
    COMMANDS = [{ id: 'a' }]
    render({ onNext: vi.fn() })
    expect(byUx('commandbar-review')!.dataset.reviewCount).toBe('0')
    expect(byUx('commandbar-review')!.textContent).toContain('nothing to review')
  })

  it('Continue moves on; Back appears only when there is a page before it (a notes run has none)', () => {
    const onNext = vi.fn()
    const onBack = vi.fn()
    render({ onNext, onBack })
    expect(container.querySelector('button.back')).not.toBeNull()
    act(() => { container.querySelector<HTMLButtonElement>('button.back')!.click() })
    expect(onBack).toHaveBeenCalledTimes(1)
    act(() => { byUx('commandbar-cta')!.click() })
    expect(onNext).toHaveBeenCalledTimes(1)
    act(() => { root.unmount() })
    root = createRoot(container)
    render({ onNext })
    expect(container.querySelector('button.back')).toBeNull()
    expect(container.querySelector('.foot .hint')!.textContent).toContain('Right-click anything on the bar')
  })
})
