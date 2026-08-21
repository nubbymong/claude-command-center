// @vitest-environment jsdom
/**
 * The command dialog asks WHAT THE BUTTON DOES first, and shows exactly what it
 * will type. Backlog items 17 and 18.
 *
 * The old dialog had one "Prompt" field that was a shell line for the partner
 * terminal and an English sentence for Claude, with a placeholder that only
 * fitted one of them, and no way to see the button or the text it would type
 * before saving it.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// CommandDialog only needs the swatch list from SessionDialog; the real module
// drags in the whole config/registry/theme graph.
vi.mock('../../../src/renderer/components/SessionDialog', () => ({
  COLOR_SWATCHES: ['#00FFFF', '#FF00FF', '#00FF7F'],
  default: () => null,
}))
vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({ sections: [], addSection: vi.fn() }),
}))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))

const { default: CommandDialog, previewLine, kindOf, targetFor } =
  await import('../../../src/renderer/components/CommandDialog')

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
  act(() => {
    root.render(React.createElement(CommandDialog, { onConfirm, onCancel: vi.fn(), ...props } as never))
  })
  return { onConfirm }
}

const labelInput = () => q<HTMLInputElement>('input[placeholder^="e.g."]')!

describe('the dialog asks what the button does FIRST', () => {
  it('hides every field until a kind is chosen, and cannot submit', () => {
    render({})
    expect(byTest('command-kind-prompt')).not.toBeNull()
    expect(byTest('command-kind-shell')).not.toBeNull()
    expect(byTest('command-text')).toBeNull()
    expect(byTest('command-preview')).toBeNull()
    expect(byTest<HTMLButtonElement>('command-submit')!.disabled).toBe(true)
  })

  it('"Run a command" produces a button that lives in the shell row', () => {
    const { onConfirm } = render({ configId: 'cfg' })
    act(() => { byTest('command-kind-shell')!.click() })
    act(() => { type(labelInput(), 'Tests'); type(byTest<HTMLTextAreaElement>('command-text')!, 'npm test') })
    act(() => { byTest('command-submit')!.click() })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0].target).toBe('partner')
    expect(onConfirm.mock.calls[0][0].prompt).toBe('npm test')
  })

  it('"Send a prompt" produces a button that lives in the Claude row', () => {
    const { onConfirm } = render({ configId: 'cfg' })
    act(() => { byTest('command-kind-prompt')!.click() })
    act(() => { type(labelInput(), 'Fix'); type(byTest<HTMLTextAreaElement>('command-text')!, 'fix the lint') })
    act(() => { byTest('command-submit')!.click() })
    expect(onConfirm.mock.calls[0][0].target).toBe('claude')
  })

  it('the text field says which kind of thing it is', () => {
    render({})
    act(() => { byTest('command-kind-shell')!.click() })
    expect(container.textContent).toContain('Command to run')
    expect(container.textContent).toContain('exactly as written')
    act(() => { byTest('command-kind-prompt')!.click() })
    expect(container.textContent).toContain('Prompt to send')
    expect(container.textContent).toContain('Submitted to Claude')
  })

  it('EDIT opens fully revealed with the kind read off the stored target', () => {
    render({
      initial: { id: 'x', label: 'Old', prompt: 'dir', scope: 'global', target: 'partner' },
    })
    expect(byTest('command-kind-shell')!.getAttribute('aria-checked')).toBe('true')
    expect(byTest('command-kind-prompt')!.getAttribute('aria-checked')).toBe('false')
    expect(byTest('command-text')).not.toBeNull()
    expect(byTest<HTMLButtonElement>('command-submit')!.disabled).toBe(false)
  })
})

describe('a terminal-only session has no Claude to prompt', () => {
  it('offers only the shell kind, and asks WHICH shell', () => {
    render({ mainPaneIsShell: true })
    expect(byTest('command-kind-prompt')).toBeNull()
    expect(byTest('command-kind-shell')).not.toBeNull()
    act(() => { byTest('command-kind-shell')!.click() })
    expect(q('[role="radiogroup"][aria-label="Which shell"]')).not.toBeNull()
  })

  it('"This shell" means the main pane, so the target is claude -- the row the main pane IS', () => {
    const { onConfirm } = render({ mainPaneIsShell: true })
    act(() => { byTest('command-kind-shell')!.click() })
    act(() => { type(labelInput(), 'L'); type(byTest<HTMLTextAreaElement>('command-text')!, 'ls') })
    act(() => { byTest('command-submit')!.click() })
    expect(onConfirm.mock.calls[0][0].target).toBe('claude')
  })

  it('"Partner shell" targets partner', () => {
    const { onConfirm } = render({ mainPaneIsShell: true })
    act(() => { byTest('command-kind-shell')!.click() })
    const partnerRadio = Array.from(container.querySelectorAll('[role="radio"]'))
      .find((b) => b.textContent === 'Partner shell') as HTMLButtonElement
    act(() => { partnerRadio.click() })
    act(() => { type(labelInput(), 'L'); type(byTest<HTMLTextAreaElement>('command-text')!, 'ls') })
    act(() => { byTest('command-submit')!.click() })
    expect(onConfirm.mock.calls[0][0].target).toBe('partner')
  })
})

describe('the preview shows the button and the exact text it will type', () => {
  it('tracks label, text and arguments live, and ends the line with an Enter mark', () => {
    render({})
    act(() => { byTest('command-kind-shell')!.click() })
    expect(byTest('command-preview-label')!.textContent).toBe('Button')
    act(() => { type(labelInput(), 'Start'); type(byTest<HTMLTextAreaElement>('command-text')!, './start.ps1') })
    expect(byTest('command-preview-label')!.textContent).toBe('Start')
    expect(byTest('command-preview-line')!.textContent).toContain('./start.ps1')
    // Add two arguments the way a user does.
    const argInput = q<HTMLInputElement>('input[placeholder^="e.g. -Port"]')!
    act(() => { type(argInput, '-Port 8080') })
    act(() => { argInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    act(() => { type(argInput, '-Background') })
    act(() => { argInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    const line = byTest('command-preview-line')!.textContent!
    expect(line).toContain('./start.ps1 -Port 8080 -Background')
    expect(line).toContain(String.fromCodePoint(0x23ce))
  })

  it('says where the text goes, in the kind\'s own verb', () => {
    render({})
    act(() => { byTest('command-kind-shell')!.click() })
    expect(byTest('command-preview')!.textContent).toContain('types into the partner shell')
    act(() => { byTest('command-kind-prompt')!.click() })
    expect(byTest('command-preview')!.textContent).toContain('sends to Claude')
  })

  it('shows the page it will watch once the watch is on', () => {
    render({})
    act(() => { byTest('command-kind-shell')!.click() })
    expect(byTest('command-preview-watch')).toBeNull()
    const cb = q<HTMLInputElement>('input[type="checkbox"]')!
    act(() => { cb.click() })
    act(() => { type(q<HTMLInputElement>('input[type="url"]')!, 'http://localhost:5173') })
    expect(byTest('command-preview-watch')!.textContent).toContain('http://localhost:5173')
  })
})

describe('the pure rules the preview and the bar share', () => {
  it('previewLine is exactly the bar\'s concatenation -- spaces, no quoting', () => {
    expect(previewLine('npm test', [])).toBe('npm test')
    expect(previewLine('npm test', ['--watch', '-t foo'])).toBe('npm test --watch -t foo')
    expect(previewLine('  x  ', ['a'])).toBe('x a')
    expect(previewLine('   ', ['a'])).toBe('')
  })

  it('kind is read off the target, and the main pane being a shell wins', () => {
    expect(kindOf({ target: 'partner' }, false)).toBe('shell')
    expect(kindOf({ target: 'claude' }, false)).toBe('prompt')
    expect(kindOf({}, false)).toBe('prompt')
    expect(kindOf({ target: 'claude' }, true)).toBe('shell')
  })

  it('targetFor: a prompt can only go to Claude; a shell line only to a shell', () => {
    expect(targetFor('prompt', false, 'main')).toBe('claude')
    expect(targetFor('shell', false, 'main')).toBe('partner')
    expect(targetFor('shell', true, 'main')).toBe('claude')
    expect(targetFor('shell', true, 'partner')).toBe('partner')
  })
})
