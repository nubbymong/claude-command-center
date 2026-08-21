// @vitest-environment jsdom
/**
 * The command dialog refuses a secret value PowerShell 5.1 cannot pass intact
 * (ADR-009 pass, beta.16): on Windows a double quote, a trailing backslash or
 * a cmd metacharacter blocks submit with the reason under the field; on POSIX
 * the same values are fine because the typed reference is quoted.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/components/SessionDialog', () => ({ COLOR_SWATCHES: ['#00FFFF', '#FF00FF', '#00FF7F'], default: () => null }))
vi.mock('../../../src/renderer/stores/commandStore', () => ({ useCommandStore: () => ({ sections: [], addSection: vi.fn() }) }))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))

const { default: CommandDialog } = await import('../../../src/renderer/components/CommandDialog')

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => { root.unmount() }); container.remove(); delete (window as any).electronPlatform })

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T | null
const byTest = <T extends Element = HTMLElement>(id: string) => q<T>(`[data-testid="${id}"]`)
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
function renderShellWithSecret(platform: string) {
  ;(window as any).electronPlatform = platform
  const onConfirm = vi.fn()
  act(() => { root.render(React.createElement(CommandDialog, { onConfirm, onCancel: vi.fn() } as never)) })
  act(() => { byTest('command-kind-shell')!.click() })
  act(() => { type(q<HTMLInputElement>('input[placeholder^="e.g."]')!, 'Deploy') })
  act(() => { type(byTest<HTMLTextAreaElement>('command-text')!, 'deploy.ps1 -Token {secret}') })
  act(() => { byTest<HTMLInputElement>('command-secret-toggle')!.click() })
  return { onConfirm }
}
const submit = () => byTest<HTMLButtonElement>('command-submit')!

describe('a secret value the shell cannot carry', () => {
  it('on Windows a value with a double quote blocks submit and says why; a clean value unblocks it', () => {
    renderShellWithSecret('win32')
    act(() => { type(byTest<HTMLInputElement>('command-secret-value')!, 'p@ss"word') })
    expect(submit().disabled).toBe(true)
    expect(byTest('command-secret-problem')?.textContent).toMatch(/double quote/)
    expect(byTest<HTMLInputElement>('command-secret-value')!.getAttribute('aria-invalid')).toBe('true')
    act(() => { type(byTest<HTMLInputElement>('command-secret-value')!, 'p@ssword') })
    expect(submit().disabled).toBe(false)
    expect(byTest('command-secret-problem')).toBeNull()
  })
  it('on Windows a trailing backslash and a cmd metacharacter are refused too', () => {
    renderShellWithSecret('win32')
    act(() => { type(byTest<HTMLInputElement>('command-secret-value')!, 'C:\\dir\\') })
    expect(submit().disabled).toBe(true)
    expect(byTest('command-secret-problem')?.textContent).toMatch(/backslash/)
    act(() => { type(byTest<HTMLInputElement>('command-secret-value')!, 'abc&whoami') })
    expect(submit().disabled).toBe(true)
    expect(byTest('command-secret-problem')?.textContent).toContain('&')
  })
  it('on POSIX the same values are accepted (the reference is quoted)', () => {
    const { onConfirm } = renderShellWithSecret('darwin')
    act(() => { type(byTest<HTMLInputElement>('command-secret-value')!, 'p@ss"word&x\\') })
    expect(submit().disabled).toBe(false)
    expect(byTest('command-secret-problem')).toBeNull()
    act(() => { submit().click() })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][1]).toBe('p@ss"word&x\\')
  })
  // (A line break cannot reach the dialog: an <input> strips newlines from its
  // value by spec. The shared rule still refuses one -- covered in
  // tests/unit/shared/command-secret-value.test.ts -- for any other caller.)
})
