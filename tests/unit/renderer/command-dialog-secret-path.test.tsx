// @vitest-environment jsdom
/**
 * The command dialog's secret path, as attacked in the ADR-009 pass on #386.
 * Four guarantee breaks were found and fixed; each is pinned here so it cannot
 * come back:
 *   1. "Make this argument a secret" must not leave the plaintext in the
 *      REMEMBERED arguments (`lastCustomArgs`) -- the next Ctrl+click typed it.
 *   2. A beta.16 record with a secret on a Global main-shell button (no `kind`,
 *      target claude) must open as a SHELL line, not a prompt -- read as a
 *      prompt, the next save deleted its keychain value.
 *   3. Turning a shell button into a PAGE must clear `hasSecretArg` (and the
 *      other typing-kind fields) explicitly -- the store merges, so the record
 *      kept `hasSecretArg: true` while the caller deleted the value.
 *   4. The one-click fix must move the RIGHT value and keep the tool's joiner:
 *      `--token=V` stays `--token={secret}`, a bare `-Token` with no value is
 *      not offered, and a key-shaped value wins over a flag that merely names a
 *      secret.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/commandStore', () => ({
  useCommandStore: () => ({ sections: [], addSection: vi.fn(), clearReview: vi.fn() }),
}))
vi.mock('../../../src/renderer/utils/id', () => ({ generateId: () => 'test-id' }))

const { default: CommandDialog } = await import('../../../src/renderer/components/CommandDialog')
const { sessionCapabilities } = await import('../../../src/renderer/lib/session-capabilities')
const { planSecretMove } = await import('../../../src/renderer/lib/command-upgrade')
const { effectiveKind } = await import('../../../src/renderer/components/command-bar/layout')

const local = sessionCapabilities({ provider: 'claude', sessionType: 'local', configId: 'cfg' } as never)
const term = sessionCapabilities({ provider: 'claude', sessionType: 'local', configId: 'cfg', shellOnly: true } as never)
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123'

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => { root.unmount() }); container.remove() })

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector(sel) as T | null
const byTest = <T extends Element = HTMLElement>(id: string) => q<T>(`[data-testid="${id}"]`)
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
function render(props: Record<string, unknown>) {
  const onConfirm = vi.fn()
  act(() => { root.render(React.createElement(CommandDialog, { onConfirm, onCancel: vi.fn(), configId: 'cfg', capabilities: local, ...props } as never)) })
  return { onConfirm }
}
const submit = () => act(() => { byTest<HTMLButtonElement>('command-submit')!.click() })

describe('1. the one-click fix forgets the remembered arguments that held the value', () => {
  it('saving after "Make this argument a secret" hands a record with no lastCustomArgs and no trace of the token', () => {
    const { onConfirm } = render({
      initial: { id: 'c1', label: 'Deploy', prompt: './deploy.ps1', scope: 'global', target: 'partner', kind: 'shell', defaultArgs: ['-Token', TOKEN], lastCustomArgs: ['-Token', TOKEN], needsReview: ['secret-like-arg'] },
    })
    act(() => { byTest('command-review-fix-secret')!.click() })
    submit()
    const [record, secret] = onConfirm.mock.calls[0]
    expect(secret).toBe(TOKEN)
    expect(record.defaultArgs).toEqual(['-Token', '{secret}'])
    expect(record.hasSecretArg).toBe(true)
    expect('lastCustomArgs' in record).toBe(true)
    expect(record.lastCustomArgs).toBeUndefined()
    expect(JSON.stringify(record)).not.toContain(TOKEN)
  })

  it('a moved value is forgotten from remembered arguments even if the user then unticks the secret', () => {
    const { onConfirm } = render({
      initial: { id: 'c1', label: 'Deploy', prompt: './deploy.ps1', scope: 'global', target: 'partner', kind: 'shell', defaultArgs: ['-Token', TOKEN], lastCustomArgs: ['-Token', TOKEN], needsReview: ['secret-like-arg'] },
    })
    act(() => { byTest('command-review-fix-secret')!.click() })
    act(() => { byTest<HTMLInputElement>('command-secret-toggle')!.click() }) // untick
    submit()
    const [record] = onConfirm.mock.calls[0]
    expect(record.hasSecretArg).toBeUndefined()
    expect(record.lastCustomArgs).toBeUndefined()
    expect(JSON.stringify(record)).not.toContain(TOKEN)
  })

  it('any save with the secret ON forgets remembered arguments; with it OFF and nothing moved, they are kept as they were', () => {
    const on = render({ initial: { id: 'c1', label: 'Deploy', prompt: 'x', scope: 'global', target: 'partner', kind: 'shell', hasSecretArg: true, defaultArgs: ['-T', '{secret}'], lastCustomArgs: ['-T', 'old-plain'] } })
    submit()
    expect(on.onConfirm.mock.calls[0][0].lastCustomArgs).toBeUndefined()
    act(() => { root.unmount() })
    root = createRoot(container)
    const off = render({ initial: { id: 'c2', label: 'Build', prompt: 'x', scope: 'global', target: 'partner', kind: 'shell', defaultArgs: ['-v'], lastCustomArgs: ['-vv'] } })
    submit()
    expect(off.onConfirm.mock.calls[0][0].lastCustomArgs).toEqual(['-vv'])
  })
})

describe('2. a legacy secret record is a shell line, whatever its target or scope said', () => {
  it('effectiveKind: hasSecretArg without a stored kind is shell on every session', () => {
    expect(effectiveKind({ scope: 'global', target: 'claude', hasSecretArg: true }, local)).toBe('shell')
    expect(effectiveKind({ scope: 'global', target: 'claude', hasSecretArg: true }, term)).toBe('shell')
    expect(effectiveKind({ scope: 'global', target: 'claude' }, local)).toBe('prompt')
  })

  it('the dialog opens such a record on the shell kind, keeps the stored secret on save, and hands no new value', () => {
    const { onConfirm } = render({
      capabilities: term,
      initial: { id: 'legacy', label: 'Deploy', prompt: './deploy.ps1', scope: 'global', target: 'claude', hasSecretArg: true, defaultArgs: ['-Token', '{secret}'] },
    })
    expect(byTest('command-kind-shell')!.getAttribute('aria-checked')).toBe('true')
    expect(byTest<HTMLInputElement>('command-secret-toggle')!.checked).toBe(true)
    submit()
    const [record, secret] = onConfirm.mock.calls[0]
    expect(record.kind).toBe('shell')
    expect(record.hasSecretArg).toBe(true)
    expect(secret).toBeUndefined()
  })
})

describe('3. a shell button with a secret turned into a page clears the typing-kind fields explicitly', () => {
  it('warns first, then hands hasSecretArg / defaultArgs / lastCustomArgs / webView as undefined keys', () => {
    const { onConfirm } = render({
      initial: { id: 's1', label: 'Deploy', prompt: './deploy.ps1', scope: 'global', target: 'partner', kind: 'shell', hasSecretArg: true, defaultArgs: ['-T', '{secret}'], lastCustomArgs: ['-T', 'x'], webView: { enabled: true, url: 'http://localhost:3000' } },
    })
    expect(byTest('command-secret-dropped')).toBeNull()
    act(() => { byTest('command-kind-page')!.click() })
    expect(byTest('command-secret-dropped')!.textContent).toContain('removes the stored value')
    act(() => { type(byTest<HTMLInputElement>('command-page-url')!, 'localhost:5173') })
    submit()
    const [record] = onConfirm.mock.calls[0]
    expect(record.kind).toBe('page')
    for (const k of ['hasSecretArg', 'defaultArgs', 'lastCustomArgs', 'webView']) {
      expect(k in record, `${k} present as an explicit key`).toBe(true)
      expect(record[k], `${k} cleared`).toBeUndefined()
    }
  })

  it('the same warning shows when a stored secret would be dropped by saving as a prompt', () => {
    render({ initial: { id: 's1', label: 'Deploy', prompt: 'x', scope: 'global', target: 'partner', kind: 'shell', hasSecretArg: true } })
    act(() => { byTest('command-kind-prompt')!.click() })
    expect(byTest('command-secret-dropped')!.textContent).toContain('a prompt')
  })
})

describe('4. planSecretMove moves the right value and keeps the joiner', () => {
  it('keeps = and : joiners, takes the key-shaped value over the flag, handles several pairs in one chip', () => {
    expect(planSecretMove(['--api-key=' + TOKEN])).toEqual({ index: 0, value: TOKEN, args: ['--api-key={secret}'] })
    expect(planSecretMove(['/Token:abc123'])).toEqual({ index: 0, value: 'abc123', args: ['/Token:{secret}'] })
    expect(planSecretMove(['--auth', 'basic', '--token', TOKEN])).toEqual({ index: 3, value: TOKEN, args: ['--auth', 'basic', '--token', '{secret}'] })
    expect(planSecretMove(['-User bob -Token ' + TOKEN])).toEqual({ index: 0, value: TOKEN, args: ['-User bob -Token {secret}'] })
    expect(planSecretMove(['-Token', 'abc123'])).toEqual({ index: 1, value: 'abc123', args: ['-Token', '{secret}'] })
  })

  it('is not offered for a bare flag with no value to move, nor for a chip already carrying {secret}', () => {
    expect(planSecretMove(['-Env', 'prod', '-Token'])).toBeNull()
    expect(planSecretMove(['-Token', '{secret}'])).toBeNull()
    expect(planSecretMove(['-Token', '-Verbose'])).toBeNull()
    expect(planSecretMove([])).toBeNull()
  })

  it('the dialog withholds the button when nothing can be moved, and names what it would move when it can', () => {
    render({ initial: { id: 'c1', label: 'Deploy', prompt: 'x', scope: 'global', target: 'partner', kind: 'shell', defaultArgs: ['-Env', 'prod', '-Token'], needsReview: ['secret-like-arg'] } })
    expect(byTest('command-review-banner')).not.toBeNull()
    expect(byTest('command-review-fix-secret')).toBeNull()
    act(() => { root.unmount() })
    root = createRoot(container)
    render({ initial: { id: 'c1', label: 'Deploy', prompt: 'x', scope: 'global', target: 'partner', kind: 'shell', defaultArgs: ['--token=' + TOKEN], needsReview: ['secret-like-arg'] } })
    const btn = byTest('command-review-fix-secret')!
    expect(btn.getAttribute('title')).toContain('--token=')
    act(() => { btn.click() })
    expect(byTest<HTMLInputElement>('command-secret-value')!.value).toBe(TOKEN)
    expect(container.textContent).toContain('--token={secret}')
  })
})

describe('a whitespace-only secret is not a value', () => {
  it('blocks submit until something other than spaces is typed', () => {
    render({})
    act(() => { byTest('command-kind-shell')!.click() })
    act(() => { type(q<HTMLInputElement>('input[placeholder^="e.g."]')!, 'D'); type(byTest<HTMLTextAreaElement>('command-text')!, 'x') })
    act(() => { byTest<HTMLInputElement>('command-secret-toggle')!.click() })
    act(() => { type(byTest<HTMLInputElement>('command-secret-value')!, '   ') })
    expect(byTest<HTMLButtonElement>('command-submit')!.disabled).toBe(true)
    act(() => { type(byTest<HTMLInputElement>('command-secret-value')!, ' tok ') })
    expect(byTest<HTMLButtonElement>('command-submit')!.disabled).toBe(false)
  })
})
