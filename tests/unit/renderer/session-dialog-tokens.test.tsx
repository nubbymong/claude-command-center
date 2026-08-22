// @vitest-environment jsdom
/**
 * #360 — SessionDialog (new / edit saved config) on the E5 dialog primitives.
 *
 * The most-seen dialog in the app, and the one with the most palette soup
 * (131 palette classes: bg-surface0 frame, bg-base inputs, text-subtext0
 * labels, bg-blue text-crust buttons...). Now: the shared frame, token
 * colours only, no click-to-close on the backdrop, Escape cancels, the
 * validation slot still names the next step, and the form still submits.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { paletteSurvivors, expectRaisedPanel, expectNoBackdropClose, expectBrandButton, pressEscape } from './dialog-tokens-harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({ groups: [{ id: 'g1', name: 'Group one' }], addGroup: vi.fn(), sections: [], addSection: vi.fn() }),
}))
vi.mock('../../../src/renderer/stores/codexAccountStore', () => ({
  useCodexAccountStore: (sel: any) => sel({ installed: false, authMode: 'none' }),
}))

if (typeof window !== 'undefined') {
  ;(window as any).electronAPI = {
    debug: { isEnabled: vi.fn().mockResolvedValue(false) },
    dialog: { openFolder: vi.fn().mockResolvedValue(null) },
    credentials: { save: vi.fn(), delete: vi.fn() },
  }
  ;(window as any).electronPlatform = 'win32'
}

import SessionDialog from '../../../src/renderer/components/SessionDialog'

let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container) })
afterEach(() => { act(() => { root.unmount() }); container.remove() })

const byTest = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const radio = (name: string, value: string) => container.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`)
const pickRadio = (name: string, value: string) => act(() => { radio(name, value)!.click() })

function render(initial?: Record<string, unknown>) {
  const onConfirm = vi.fn(); const onCancel = vi.fn()
  act(() => { root.render(React.createElement(SessionDialog, { onConfirm, onCancel, initial } as never)) })
  return { onConfirm, onCancel }
}

const EDIT_SSH = { id: 'c1', provider: 'claude', sessionType: 'ssh', label: 'Box', sshConfig: { host: 'h', port: 22, username: 'u', remotePath: '~', postCommand: 'sudo x', hasPassword: true }, groupId: 'g1' }
const EDIT_CODEX = { id: 'c2', provider: 'codex', sessionType: 'local', label: 'Cx', workingDirectory: 'C:\\p' }
const EDIT_TERM = { id: 'c3', provider: 'claude', shellOnly: true, sessionType: 'local', label: 'T', workingDirectory: 'rel/path', terminalOptions: { command: 'npm run dev' } }

describe('the frame', () => {
  it('is the raised panel by token with a brand submit and no palette class (new config, nothing chosen yet)', () => {
    render()
    expectRaisedPanel(container.querySelector('[role="dialog"]'))
    expectBrandButton(byTest('session-dialog-submit'))
    expect(paletteSurvivors(byTest('session-dialog')!)).toEqual([])
    // the validation slot names the next step, in the warning tone
    expect(byTest('session-dialog-validation')!.textContent!.length).toBeGreaterThan(0)
    expect(byTest('session-dialog-validation')!.style.color).toBe('var(--status-warning)')
  })

  it('the overlay has no click-to-close, and Escape does NOT discard the form', () => {
    const { onCancel } = render()
    expectNoBackdropClose(byTest('session-dialog'), () => onCancel.mock.calls.length === 0)
    // This dialog holds unsaved input (name, working dir, args, env), so
    // Escape is deliberately inert: a reflex keypress on the way out of a
    // field must not discard a half-filled config with no confirm and no undo.
    pressEscape()
    expect(onCancel).not.toHaveBeenCalled()
    act(() => { container.querySelector<HTMLElement>('button[aria-label="Cancel"]')!.click() })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('no palette class survives in any reveal', () => {
  it('a new Claude local config, fully revealed, with the help hints open', () => {
    render()
    pickRadio('ccc-provider', 'claude')
    pickRadio('ccc-transport', 'local')
    // HelpBtn is an inline component type, so each click remounts the rest -- re-query every time
    const n = container.querySelectorAll('button[aria-expanded]').length
    for (let i = 0; i < n; i++) act(() => { container.querySelectorAll<HTMLElement>('button[aria-expanded]')[i].click() })
    expect(container.querySelectorAll('button[aria-expanded="true"]').length).toBeGreaterThan(3)
    expect(paletteSurvivors(byTest('session-dialog')!)).toEqual([])
  })

  it('editing an SSH config with a stored password, a post-command and a group (the yellow "grouped" note)', () => {
    render(EDIT_SSH)
    expect(byTest('ssh-detachable')).not.toBeNull()
    expect(container.textContent).toContain('Remove stored password')
    expect(container.textContent).toContain("Grouped configs can't also sit under a section")
    expect(paletteSurvivors(byTest('session-dialog')!)).toEqual([])
  })

  it('editing a Codex config (the Codex form fields and their "not installed" banner)', () => {
    render(EDIT_CODEX)
    expect(container.textContent).toContain('Codex CLI is not installed')
    expect(paletteSurvivors(byTest('session-dialog')!)).toEqual([])
  })

  it('editing a Terminal-only config with a relative working directory (the "not a full path" warning)', () => {
    render(EDIT_TERM)
    expect(container.textContent).toContain('Not a full path')
    expect(paletteSurvivors(byTest('session-dialog')!)).toEqual([])
  })
})

describe('the provider cards', () => {
  it('the chosen card takes the brand border via an arbitrary-value class; the others the subtle one', () => {
    render()
    pickRadio('ccc-provider', 'claude')
    const claude = radio('ccc-provider', 'claude')!.closest('label')!
    const codex = radio('ccc-provider', 'codex')!.closest('label')!
    expect(claude.className).toContain('border-[var(--brand)]')
    expect(codex.className).toContain('border-[var(--border-subtle)]')
  })
})

describe('behaviour is unchanged', () => {
  it('a complete new Claude local config still submits through the form', () => {
    const { onConfirm } = render()
    pickRadio('ccc-provider', 'claude')
    pickRadio('ccc-transport', 'local')
    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input'))
    const wd = inputs.find((i) => i.placeholder.includes('path'))!
    const label = inputs.find((i) => i.placeholder === 'e.g. App Dev')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    act(() => { setter.call(wd, 'C:\\proj'); wd.dispatchEvent(new Event('input', { bubbles: true })) })
    act(() => { setter.call(label, 'Proj'); label.dispatchEvent(new Event('input', { bubbles: true })) })
    expect(byTest('session-dialog-validation')!.textContent).toBe('')
    expect((byTest('session-dialog-submit') as HTMLButtonElement).disabled).toBe(false)
    act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(onConfirm).toHaveBeenCalledTimes(1)
    expect(onConfirm.mock.calls[0][0]).toMatchObject({ label: 'Proj', workingDirectory: 'C:\\proj', sessionType: 'local' })
  })
})
