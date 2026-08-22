// @vitest-environment jsdom
/**
 * The third kind of command button: "Open a page" (item 26). It types nothing;
 * it sends the session's browser pane to a URL. The dialog asks for a label
 * and a page, nothing else, and saves the normalised URL with `kind: 'page'`.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/components/SessionDialog', () => ({
  COLOR_SWATCHES: ['#00FFFF', '#FF00FF', '#00FF7F'],
  default: () => null,
}))
vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({ sections: [], addSection: vi.fn() }),
}))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))

const { default: CommandDialog, kindOf, targetFor } = await import('../../../src/renderer/components/CommandDialog')
const { sessionCapabilities } = await import('../../../src/renderer/lib/session-capabilities')
const claudeCaps = sessionCapabilities({ provider: 'claude', sessionType: 'local', configId: 'cfg' } as never)
const shellCaps = sessionCapabilities({ provider: 'claude', sessionType: 'local', configId: 'cfg', shellOnly: true } as never)

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
  act(() => { root.render(React.createElement(CommandDialog, { onConfirm, onCancel: vi.fn(), ...props } as never)) })
  return { onConfirm }
}
const labelInput = () => q<HTMLInputElement>('input[placeholder^="e.g."]')!
const submit = () => act(() => { byTest<HTMLButtonElement>('command-submit')!.click() })
const pickPage = () => act(() => { byTest('command-kind-page')!.click() })

describe('the page card', () => {
  it('is offered alongside the two typing kinds -- and on a terminal-only session too', () => {
    render({})
    expect(byTest('command-kind-page')).not.toBeNull()
    act(() => { root.unmount() })
    root = createRoot(container)
    render({ capabilities: shellCaps })
    expect(byTest('command-kind-prompt')).toBeNull()
    expect(byTest('command-kind-page')).not.toBeNull()
  })
  it('choosing it asks for a label and a page and NOTHING that belongs to typing', () => {
    render({})
    pickPage()
    expect(byTest('command-page-url')).not.toBeNull()
    expect(byTest('command-text')).toBeNull()
    expect(byTest('command-watch-toggle')).toBeNull()
    expect(byTest('command-secret-toggle')).toBeNull()
    expect(container.textContent).not.toContain('Arguments')
    // "Where it runs" is answered for a page too -- the browser pane, fetched
    // from this PC -- so no kind is silent about the machine (ADR-018 D12).
    expect(byTest('command-runs-in')!.textContent).toContain('From this PC')
    expect(byTest('command-runs-in')!.textContent).toContain('browser pane')
    // Where it shows, section, icon and colour are still there: a page button is filed like any other.
    expect(container.textContent).toContain('Where it shows')
    expect(container.textContent).toContain('Section')
    expect(container.textContent).toContain('Colour')
    expect(container.textContent).toContain('Icon')
  })
})

describe('saving a page button', () => {
  it('cannot submit without a label and a page', () => {
    render({})
    pickPage()
    expect(byTest<HTMLButtonElement>('command-submit')!.disabled).toBe(true)
    act(() => { type(labelInput(), 'Docs') })
    expect(byTest<HTMLButtonElement>('command-submit')!.disabled).toBe(true)
    act(() => { type(byTest<HTMLInputElement>('command-page-url')!, 'localhost:5173') })
    expect(byTest<HTMLButtonElement>('command-submit')!.disabled).toBe(false)
  })
  it('saves kind:page with the NORMALISED url, an empty prompt, filed in the main row, and no secret', () => {
    const { onConfirm } = render({ configId: 'cfg' })
    pickPage()
    act(() => { type(labelInput(), 'Docs') })
    act(() => { type(byTest<HTMLInputElement>('command-page-url')!, 'localhost:5173') })
    submit()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    const [cmd, secret] = onConfirm.mock.calls[0]
    expect(cmd).toMatchObject({ label: 'Docs', kind: 'page', pageUrl: 'http://localhost:5173/', prompt: '', target: 'claude', scope: 'config', configId: 'cfg' })
    expect(cmd.webView).toBeUndefined()
    expect(cmd.hasSecretArg).toBeUndefined()
    expect(cmd.defaultArgs).toBeUndefined()
    expect(secret).toBeUndefined()
  })
  it('refuses a page that is not http/https, by name, and does not confirm', () => {
    const { onConfirm } = render({})
    pickPage()
    act(() => { type(labelInput(), 'Bad') })
    act(() => { type(byTest<HTMLInputElement>('command-page-url')!, 'javascript:alert(1)') })
    submit()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(q('#page-url-error')?.textContent).toMatch(/not javascript/)
    // Typing again clears the error.
    act(() => { type(byTest<HTMLInputElement>('command-page-url')!, 'https://ok.example/') })
    expect(q('#page-url-error')).toBeNull()
  })
  it('the preview names the destination and the normalised page, and says it types nothing', () => {
    render({})
    pickPage()
    act(() => { type(labelInput(), 'Docs') })
    act(() => { type(byTest<HTMLInputElement>('command-page-url')!, 'docs.example.com/guide') })
    // The preview draws the bar's real chip: a page button wears the globe glyph.
    const chip = byTest('command-preview')!.querySelector('[data-testid="command-chip"]')!
    expect(chip.textContent).toContain('Docs')
    expect(chip.querySelector('[data-testid="command-page-glyph"]')).not.toBeNull()
    expect(byTest('command-preview')!.textContent).toContain('opens in the browser pane (from this PC)')
    expect(byTest('command-preview-line')!.textContent).toContain('https://docs.example.com/guide')
    expect(byTest('command-preview-line')!.textContent).toContain('types nothing')
  })
})

describe('editing one', () => {
  it('opens on the page kind with the page filled in', () => {
    render({ initial: { id: 'p1', label: 'Docs', prompt: '', scope: 'global', kind: 'page', pageUrl: 'https://docs.example.com/' } })
    expect(byTest('command-kind-page')!.getAttribute('aria-checked')).toBe('true')
    expect(byTest<HTMLInputElement>('command-page-url')!.value).toBe('https://docs.example.com/')
    expect(byTest('command-text')).toBeNull()
  })
})

describe('kindOf / targetFor know the third kind', () => {
  it('kindOf reads the stored mark first', () => {
    expect(kindOf({ kind: 'page', target: 'partner', scope: 'global' }, claudeCaps)).toBe('page')
    expect(kindOf({ kind: 'page', scope: 'config' }, shellCaps)).toBe('page')
    expect(kindOf({ target: 'partner', scope: 'global' }, claudeCaps)).toBe('shell')
    expect(kindOf({ scope: 'global' }, claudeCaps)).toBe('prompt')
  })
  it('a page button is filed with the main pane\'s buttons', () => {
    expect(targetFor('page', claudeCaps, 'main')).toBe('claude')
    expect(targetFor('page', shellCaps, 'partner')).toBe('claude')
  })
})
