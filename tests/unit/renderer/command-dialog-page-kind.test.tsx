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
    render({ mainPaneIsShell: true })
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
    expect(byTest('command-runs-in')).toBeNull()
    expect(container.textContent).not.toContain('Arguments')
    // Scope, section and colour are still there: a page button is filed like any other.
    expect(container.textContent).toContain('Scope')
    expect(container.textContent).toContain('Section')
    expect(container.textContent).toContain('Colour')
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
    expect(byTest('command-preview-label')!.textContent).toBe('Docs')
    expect(byTest('command-preview')!.textContent).toContain('opens in the browser pane')
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
    expect(kindOf({ kind: 'page', target: 'partner' }, false)).toBe('page')
    expect(kindOf({ kind: 'page' }, true)).toBe('page')
    expect(kindOf({ target: 'partner' }, false)).toBe('shell')
    expect(kindOf({}, false)).toBe('prompt')
  })
  it('a page button is filed in the main row', () => {
    expect(targetFor('page', false, 'main')).toBe('claude')
    expect(targetFor('page', true, 'partner')).toBe('claude')
  })
})
