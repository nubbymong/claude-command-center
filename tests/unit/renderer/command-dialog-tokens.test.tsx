// @vitest-environment jsdom
/**
 * The command dialog's E5 look is TOKEN-DRIVEN (ADR-018 D12): surfaces, borders,
 * brand and status colours come from CSS variables set by the theme, not from
 * Catppuccin utility classes baked into the markup.
 *
 * Why this is tested: the old dialog was `bg-mantle` / `text-subtext0` /
 * `border-surface1` soup, which is why it could not follow a theme and why a
 * restyle meant touching every line. The new surfaces take their colours from
 * `--surface-*`, `--border-*`, `--brand` and `--status-*` only. These tests pin
 * that: the tokens on the load-bearing surfaces, and a sweep that reports any
 * palette class that survived on ANY element inside the dialog.
 *
 * Also here: the overlay has no click-to-close (the modal-backdrop rule in
 * AGENTS.md -- Ctrl+C fires click events), and the Icon field carries no
 * colour row of its own (the colours have their own field).
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const store = vi.hoisted(() => ({ sections: [] as unknown[], addSection: vi.fn(), clearReview: vi.fn() }))
vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({ sections: store.sections, addSection: store.addSection, clearReview: store.clearReview }),
}))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))

const { default: CommandDialog } = await import('../../../src/renderer/components/CommandDialog')
const { sessionCapabilities } = await import('../../../src/renderer/lib/session-capabilities')
const local = sessionCapabilities({ provider: 'claude', sessionType: 'local', configId: 'cfg' } as never)

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T | null
const byTest = <T extends Element = HTMLElement>(id: string) => q<T>(`[data-testid="${id}"]`)

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
function render(props: Record<string, unknown>) {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  act(() => { root.render(React.createElement(CommandDialog, { onConfirm, onCancel, ...props } as never)) })
  return { onConfirm, onCancel }
}
const pick = (kind: 'prompt' | 'shell' | 'page') => act(() => { byTest(`command-kind-${kind}`)!.click() })
const click = (id: string) => act(() => { byTest(id)!.click() })

/** Every class token on every element inside the dialog that is still a
 *  Catppuccin palette utility. Empty means the surfaces are token-driven. */
const PALETTE_CLASS = /^(bg-mantle|bg-surface0|text-subtext0|text-overlay\d|border-surface1|bg-blue|text-blue|bg-crust)/
function paletteSurvivors(): string[] {
  const out: string[] = []
  for (const el of Array.from(container.querySelectorAll('[class]'))) {
    for (const token of (el.getAttribute('class') ?? '').split(/\s+/)) {
      if (PALETTE_CLASS.test(token)) out.push(`${el.tagName.toLowerCase()}[data-testid="${el.getAttribute('data-testid') ?? ''}"] .${token}`)
    }
  }
  return out
}

describe('the dialog shell', () => {
  it('the panel is a raised surface with a subtle border, by token', () => {
    render({ capabilities: local, configId: 'cfg' })
    const panel = q<HTMLElement>('[role="dialog"]')!
    expect(panel.style.background).toBe('var(--surface-raised)')
    expect(panel.style.border).toContain('var(--border-subtle)')
  })

  it('clicking the overlay does NOT close the dialog (Ctrl+C fires click events)', () => {
    const { onCancel } = render({ capabilities: local, configId: 'cfg' })
    const overlay = byTest('command-dialog')!
    expect(overlay.onclick).toBeNull()
    act(() => { overlay.click() })
    act(() => { overlay.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('the submit button is the brand colour', () => {
    render({ capabilities: local, configId: 'cfg' })
    expect(byTest('command-submit')!.style.background).toBe('var(--brand)')
  })
})

describe('the kind tiles and segment chips', () => {
  it('the chosen tile takes the brand border; the others the subtle one', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('shell')
    const shell = byTest('command-kind-shell')!
    const prompt = byTest('command-kind-prompt')!
    expect(shell.getAttribute('aria-checked')).toBe('true')
    expect(shell.style.borderColor).toBe('var(--brand)')
    expect(prompt.getAttribute('aria-checked')).toBe('false')
    expect(prompt.style.borderColor).toBe('var(--border-subtle)')
  })

  it('the chosen "Where it shows" chip is a brand tint mixed from the token', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('prompt')
    const session = byTest('command-scope-config')!
    const global = byTest('command-scope-global')!
    expect(session.getAttribute('aria-checked')).toBe('true')
    expect(session.style.background).toContain('color-mix')
    expect(session.style.background).toContain('var(--brand)')
    expect(global.style.background).toBe('var(--surface-raised)')
  })
})

describe('inputs and callouts', () => {
  it('the text input sits on the base surface with the strong border', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('prompt')
    const input = byTest('command-label')!
    expect(input.style.background).toBe('var(--surface-base)')
    expect(input.style.borderColor).toBe('var(--border-strong)')
  })

  it('the review banner is bordered with the warning status token', () => {
    render({
      capabilities: local, configId: 'cfg',
      initial: { id: 's1', label: 'X', prompt: 'dir', scope: 'global', target: 'partner', kind: 'shell', needsReview: ['section-dissolved'] },
    })
    const banner = byTest('command-review-banner')!
    expect(banner).not.toBeNull()
    expect(banner.style.borderColor).toContain('var(--status-warning)')
  })

  it('the secret callout, once the toggle is on, uses the warning status token', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('shell')
    expect(byTest('command-secret-callout')).toBeNull()
    click('command-secret-toggle')
    const callout = byTest('command-secret-callout')!
    expect(callout).not.toBeNull()
    expect(callout.style.borderColor).toContain('var(--status-warning)')
  })
})

describe('no Catppuccin class soup on the new surfaces', () => {
  it('a new prompt button', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('prompt')
    expect(paletteSurvivors()).toEqual([])
  })

  it('a shell button with the secret on, the watch on, and the review banner up', () => {
    render({
      capabilities: local, configId: 'cfg',
      initial: { id: 'r1', label: 'Deploy', prompt: './deploy.ps1', scope: 'global', target: 'partner', kind: 'shell', hasSecretArg: true, defaultArgs: ['-T {secret}'], webView: { enabled: true, url: 'http://localhost:3000' }, needsReview: ['secret-like-arg', 'ssh-partner-is-local'] },
    })
    expect(byTest('command-review-banner')).not.toBeNull()
    expect(byTest('command-secret-callout')).not.toBeNull()
    expect(paletteSurvivors()).toEqual([])
  })

  it('a page button with the "New section…" input open', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('page')
    act(() => { type(byTest<HTMLInputElement>('command-page-url')!, 'https://docs.example.com') })
    const select = byTest<HTMLSelectElement>('command-section')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, '__new__')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(byTest('command-new-section-name')).not.toBeNull()
    expect(paletteSurvivors()).toEqual([])
  })
})

describe('the Icon field', () => {
  it('carries the icon picks and no colour row of its own -- colours have their own field', () => {
    render({ capabilities: local, configId: 'cfg' })
    pick('prompt')
    expect(q('[data-testid="command-field-icon"] [data-testid="icon-colour-picker"]')).not.toBeNull()
    expect(q('[data-testid="command-field-icon"] [data-testid="icon-pick-monogram"]')).not.toBeNull()
    expect(q('[data-testid="command-field-colour"] [data-testid="command-colours"]')).not.toBeNull()
    // honours showColours={false} (menus.tsx)
    expect(container.querySelector('[data-testid="command-field-icon"] [data-testid="colour-picks"]')).toBeNull()
  })
})
