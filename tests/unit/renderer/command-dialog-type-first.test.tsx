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
const { sessionCapabilities } = await import('../../../src/renderer/lib/session-capabilities')
// The two sessions these tests speak of: a local Claude session, and a
// terminal-only one whose main pane is itself a shell (ADR-018 D2).
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

  it('"Run a command" produces a shell-kind button aimed at the partner shell', () => {
    const { onConfirm } = render({ configId: 'cfg' })
    act(() => { byTest('command-kind-shell')!.click() })
    act(() => { type(labelInput(), 'Tests'); type(byTest<HTMLTextAreaElement>('command-text')!, 'npm test') })
    act(() => { byTest('command-submit')!.click() })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0].target).toBe('partner')
    expect(onConfirm.mock.calls[0][0].kind).toBe('shell')
    expect(onConfirm.mock.calls[0][0].prompt).toBe('npm test')
  })

  it('"Send a prompt" produces a prompt-kind button aimed at the agent', () => {
    const { onConfirm } = render({ configId: 'cfg' })
    act(() => { byTest('command-kind-prompt')!.click() })
    act(() => { type(labelInput(), 'Fix'); type(byTest<HTMLTextAreaElement>('command-text')!, 'fix the lint') })
    act(() => { byTest('command-submit')!.click() })
    expect(onConfirm.mock.calls[0][0].target).toBe('claude')
    expect(onConfirm.mock.calls[0][0].kind).toBe('prompt')
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
  it('offers only the shell kind, and asks WHICH shell -- both on this PC, both enabled', () => {
    render({ capabilities: shellCaps })
    expect(byTest('command-kind-prompt')).toBeNull()
    expect(byTest('command-kind-shell')).not.toBeNull()
    act(() => { byTest('command-kind-shell')!.click() })
    expect(q('[role="radiogroup"][aria-label="Where it runs"]')).not.toBeNull()
    const main = byTest<HTMLButtonElement>('command-where-main')!
    const partner = byTest<HTMLButtonElement>('command-where-partner')!
    expect(main.disabled).toBe(false)
    expect(partner.disabled).toBe(false)
    expect(main.textContent).toContain('this shell')
    expect(partner.textContent).toContain('partner shell')
  })

  it('the legacy prop still works: mainPaneIsShell alone describes a terminal-only session', () => {
    render({ mainPaneIsShell: true })
    expect(byTest('command-kind-prompt')).toBeNull()
    act(() => { byTest('command-kind-shell')!.click() })
    expect(byTest<HTMLButtonElement>('command-where-main')!.disabled).toBe(false)
  })

  it('"This shell" means the main pane, so the target is claude -- the pane the main shell IS', () => {
    const { onConfirm } = render({ capabilities: shellCaps })
    act(() => { byTest('command-kind-shell')!.click() })
    expect(byTest('command-where-main')!.getAttribute('aria-checked')).toBe('true')
    act(() => { type(labelInput(), 'L'); type(byTest<HTMLTextAreaElement>('command-text')!, 'ls') })
    act(() => { byTest('command-submit')!.click() })
    expect(onConfirm.mock.calls[0][0].target).toBe('claude')
    expect(onConfirm.mock.calls[0][0].kind).toBe('shell')
  })

  it('"Partner shell" targets partner', () => {
    const { onConfirm } = render({ capabilities: shellCaps })
    act(() => { byTest('command-kind-shell')!.click() })
    act(() => { byTest('command-where-partner')!.click() })
    act(() => { type(labelInput(), 'L'); type(byTest<HTMLTextAreaElement>('command-text')!, 'ls') })
    act(() => { byTest('command-submit')!.click() })
    expect(onConfirm.mock.calls[0][0].target).toBe('partner')
  })

  it('on an agent session the main pane is offered but disabled, with the reason', () => {
    render({ capabilities: claudeCaps })
    act(() => { byTest('command-kind-shell')!.click() })
    const main = byTest<HTMLButtonElement>('command-where-main')!
    expect(main.disabled).toBe(true)
    expect(main.textContent).toContain('not a shell')
    expect(byTest('command-where-partner')!.getAttribute('aria-checked')).toBe('true')
  })
})

describe('the preview shows the button and the exact text it will type', () => {
  // The preview draws the REAL chip (the bar's own component), so the label is
  // read off that chip -- its monogram tile precedes the text.
  const previewChip = () => byTest('command-preview')!.querySelector('[data-testid="command-chip"]')!

  it('tracks label, text and arguments live, and ends the line with an Enter mark', () => {
    render({})
    act(() => { byTest('command-kind-shell')!.click() })
    expect(previewChip().textContent).toContain('Button')
    act(() => { type(labelInput(), 'Start'); type(byTest<HTMLTextAreaElement>('command-text')!, './start.ps1') })
    expect(previewChip().textContent).toContain('Start')
    expect(previewChip().textContent).not.toContain('Button')
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
    expect(byTest('command-preview')!.textContent).toContain('sends to the Claude terminal')
  })

  it('shows the page it will watch once the watch is on', () => {
    render({})
    act(() => { byTest('command-kind-shell')!.click() })
    expect(byTest('command-preview-watch')).toBeNull()
    // By testid, not "the first checkbox": the secret toggle now comes first
    // in DOM order, and that is exactly what this assertion tripped over.
    const cb = byTest<HTMLInputElement>('command-watch-toggle')!
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

  it('kind is the stored kind when there is one; a legacy record is read off target and scope', () => {
    expect(kindOf({ kind: 'shell', target: 'claude', scope: 'global' }, claudeCaps)).toBe('shell')
    expect(kindOf({ target: 'partner', scope: 'global' }, claudeCaps)).toBe('shell')
    expect(kindOf({ target: 'claude', scope: 'global' }, claudeCaps)).toBe('prompt')
    expect(kindOf({ scope: 'global' }, claudeCaps)).toBe('prompt')
    // Terminal-only: a Session button of that config is the shell's own line;
    // a Global claude-target button is still a prompt (it cannot run here).
    expect(kindOf({ target: 'claude', scope: 'config' }, shellCaps)).toBe('shell')
    expect(kindOf({ target: 'claude', scope: 'global' }, shellCaps)).toBe('prompt')
    expect(kindOf(undefined, shellCaps)).toBe('prompt')
  })

  it('targetFor: a prompt can only go to the agent; a shell line only to a shell', () => {
    expect(targetFor('prompt', claudeCaps, 'main')).toBe('claude')
    expect(targetFor('page', claudeCaps, 'partner')).toBe('claude')
    expect(targetFor('shell', claudeCaps, 'main')).toBe('partner')
    expect(targetFor('shell', shellCaps, 'main')).toBe('claude')
    expect(targetFor('shell', shellCaps, 'partner')).toBe('partner')
  })
})

describe('a secret argument (shell kind only)', () => {
  const armShell = () => {
    render({ configId: 'cfg' })
    act(() => { byTest('command-kind-shell')!.click() })
    act(() => { type(labelInput(), 'Deploy'); type(byTest<HTMLTextAreaElement>('command-text')!, './deploy.ps1') })
  }

  it('is offered for a shell command and NOT for a prompt', () => {
    render({})
    act(() => { byTest('command-kind-prompt')!.click() })
    expect(byTest('command-secret-toggle')).toBeNull()
    act(() => { byTest('command-kind-shell')!.click() })
    expect(byTest('command-secret-toggle')).not.toBeNull()
  })

  it('switched on with no value, the button cannot be created', () => {
    armShell()
    act(() => { byTest<HTMLInputElement>('command-secret-toggle')!.click() })
    expect(byTest<HTMLButtonElement>('command-submit')!.disabled).toBe(true)
  })

  it('hands the VALUE to the caller separately, and marks the command -- the value is never in the record', () => {
    const onConfirm = vi.fn()
    act(() => { root.render(React.createElement(CommandDialog, { onConfirm, onCancel: vi.fn(), configId: 'cfg' } as never)) })
    act(() => { byTest('command-kind-shell')!.click() })
    act(() => { type(labelInput(), 'Deploy'); type(byTest<HTMLTextAreaElement>('command-text')!, './deploy.ps1') })
    act(() => { byTest<HTMLInputElement>('command-secret-toggle')!.click() })
    act(() => { type(byTest<HTMLInputElement>('command-secret-value')!, 'sk-verysecret') })
    act(() => { byTest('command-submit')!.click() })
    const [record, secret] = onConfirm.mock.calls[0]
    expect(record.hasSecretArg).toBe(true)
    expect(secret).toBe('sk-verysecret')
    expect(JSON.stringify(record)).not.toContain('sk-verysecret')
  })

  it('the preview shows the REFERENCE where {secret} is, never the value', () => {
    ;(globalThis as any).window.electronPlatform = 'win32'
    armShell()
    const argInput = q<HTMLInputElement>('input[placeholder^="e.g. -Port"]')!
    act(() => { type(argInput, '-Token {secret}') })
    act(() => { argInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    act(() => { byTest<HTMLInputElement>('command-secret-toggle')!.click() })
    act(() => { type(byTest<HTMLInputElement>('command-secret-value')!, 'sk-verysecret') })
    const line = byTest('command-preview-line')!.textContent!
    expect(line).toContain('-Token ${env:CCC_CMD_SECRET_')
    expect(line).not.toContain('sk-verysecret')
    expect(line).not.toContain('{secret}')
  })

  it('on edit, a stored secret is kept unless replaced, and switching it off reports that', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(React.createElement(CommandDialog, {
        onConfirm, onCancel: vi.fn(), configId: 'cfg',
        initial: { id: 'abc123', label: 'Deploy', prompt: './deploy.ps1', scope: 'global', target: 'partner', hasSecretArg: true, defaultArgs: ['-T {secret}'] },
      } as never))
    })
    expect(byTest<HTMLInputElement>('command-secret-toggle')!.checked).toBe(true)
    // Nothing typed: submit is allowed (stored value stays), and no value is handed over.
    expect(byTest<HTMLButtonElement>('command-submit')!.disabled).toBe(false)
    act(() => { byTest('command-submit')!.click() })
    expect(onConfirm.mock.calls[0][0].hasSecretArg).toBe(true)
    expect(onConfirm.mock.calls[0][1]).toBeUndefined()
    // Switch it off: the record says so, which is the caller's cue to delete.
    act(() => { byTest<HTMLInputElement>('command-secret-toggle')!.click() })
    act(() => { byTest('command-submit')!.click() })
    expect(onConfirm.mock.calls[1][0].hasSecretArg).toBeUndefined()
  })
})
