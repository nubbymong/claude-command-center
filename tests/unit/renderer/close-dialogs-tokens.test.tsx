// @vitest-environment jsdom
/**
 * #360 — CloseDialog and SshCloseDialog on the E5 dialog primitives.
 *
 * The two "are you sure" dialogs a user sees most: closing the app with live
 * sessions, and closing a persistent SSH tab. Both were `bg-surface0
 * border-surface1 text-overlay1 bg-blue text-crust` soup. Now: the shared
 * frame, token colours only, no click-to-close on the backdrop, Escape
 * cancels, and the behaviour (which button calls what) is unchanged.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { paletteSurvivors, expectRaisedPanel, expectNoBackdropClose, expectBrandButton, pressEscape } from './dialog-tokens-harness'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const ssh = vi.hoisted(() => ({
  pending: null as null | { sessionId: string; label: string; host?: string; remoteAccount?: string },
  clear: vi.fn(),
  endRemoteAndClose: vi.fn(async () => {}),
  leaveRunningAndClose: vi.fn(),
}))
vi.mock('../../../src/renderer/stores/sshCloseStore', () => ({
  useSshCloseStore: (sel: (s: { pending: typeof ssh.pending; clear: () => void }) => unknown) => sel({ pending: ssh.pending, clear: ssh.clear }),
  endRemoteAndClose: ssh.endRemoteAndClose,
  leaveRunningAndClose: ssh.leaveRunningAndClose,
}))

const { default: CloseDialog } = await import('../../../src/renderer/components/CloseDialog')
const { default: SshCloseDialog } = await import('../../../src/renderer/components/SshCloseDialog')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  ssh.pending = null
  ssh.clear.mockClear(); ssh.endRemoteAndClose.mockClear(); ssh.leaveRunningAndClose.mockClear()
})
afterEach(() => { act(() => { root.unmount() }); container.remove() })

const byTest = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const click = (el: HTMLElement | null) => act(() => { el!.click() })

describe('CloseDialog', () => {
  function render(mode: 'close' | 'update' = 'close') {
    const props = { onSaveAndClose: vi.fn(), onCloseWithoutSaving: vi.fn(), onCancel: vi.fn() }
    act(() => { root.render(React.createElement(CloseDialog, { mode, sessionCount: 2, ...props })) })
    return props
  }

  it('is the raised panel by token, with a brand primary and no palette class', () => {
    render()
    expectRaisedPanel(container.querySelector('[role="dialog"]'))
    expectBrandButton(byTest('close-dialog-save'))
    expect(paletteSurvivors(byTest('close-dialog')!)).toEqual([])
  })

  it('the overlay has no click-to-close; Escape cancels', () => {
    const p = render()
    expectNoBackdropClose(byTest('close-dialog'), () => byTest('close-dialog') !== null && !p.onCancel.mock.calls.length)
    pressEscape()
    expect(p.onCancel).toHaveBeenCalledTimes(1)
  })

  it('the three buttons still call the three handlers', () => {
    const p = render('update')
    expect(container.textContent).toContain('Update and restart')
    click(byTest('close-dialog-save')); expect(p.onSaveAndClose).toHaveBeenCalledTimes(1)
    click(byTest('close-dialog-discard')); expect(p.onCloseWithoutSaving).toHaveBeenCalledTimes(1)
    click(byTest('close-dialog-cancel')); expect(p.onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('SshCloseDialog', () => {
  function render() {
    act(() => { root.render(React.createElement(SshCloseDialog)) })
  }

  it('renders nothing when nothing is pending', () => {
    render()
    expect(byTest('ssh-close-dialog')).toBeNull()
  })

  it('is the raised panel by token; "End remote session" is the danger tone; no palette class', () => {
    ssh.pending = { sessionId: 's1', label: 'build box', host: 'h.example', remoteAccount: 'nick' }
    render()
    expectRaisedPanel(container.querySelector('[role="dialog"]'))
    const end = byTest('ssh-close-end')!
    // A SOLID danger fill, not a tint -- it kills the remote tmux session.
    expect(end.style.background).toBe('var(--status-danger)')
    // …and it must not sit in the rightmost (confirm/default) slot, which is
    // where every other confirm puts its SAFE action. "Leave running" is last
    // and holds the focus, so Enter and muscle memory cannot end the remote.
    const buttons = Array.from(byTest('ssh-close-dialog')!.querySelectorAll('button'))
    expect(buttons.indexOf(end)).toBeLessThan(buttons.indexOf(byTest('ssh-close-leave')!))
    expect(buttons[buttons.length - 1]).toBe(byTest('ssh-close-leave'))
    expect(paletteSurvivors(byTest('ssh-close-dialog')!)).toEqual([])
    expect(container.textContent).toContain('h.example')
    expect(container.textContent).toContain('nick')
  })

  it('the overlay has no click-to-close; Escape clears; the buttons keep their test ids and actions', async () => {
    ssh.pending = { sessionId: 's1', label: 'build box' }
    render()
    expectNoBackdropClose(byTest('ssh-close-dialog'), () => ssh.clear.mock.calls.length === 0)
    pressEscape()
    expect(ssh.clear).toHaveBeenCalledTimes(1)
    click(byTest('ssh-close-leave')); expect(ssh.leaveRunningAndClose).toHaveBeenCalledWith('s1')
    await act(async () => { byTest('ssh-close-end')!.click() })
    expect(ssh.endRemoteAndClose).toHaveBeenCalledWith('s1')
    click(byTest('ssh-close-cancel')); expect(ssh.clear).toHaveBeenCalledTimes(2)
  })
})
