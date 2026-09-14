// @vitest-environment jsdom
/**
 * 2.1.0-beta.6: Terminal-only launcher options (first-run command, arguments,
 * secret argument, Run as Administrator). These were drawn in the approved
 * mockup but shipped without a backend in beta.5 — this pins the dialog half:
 *   1. The fields render for a LOCAL Terminal-only config, and not for Claude
 *      Code / Codex / SSH.
 *   2. They persist into config.terminalOptions on submit.
 *   3. The secret argument NEVER enters the config object — it is handed to the
 *      caller as a separate argument for the OS keychain.
 *   4. Clearing the secret (or switching away from a local terminal) deletes the
 *      stored keychain entry rather than stranding it.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({
    groups: [], addGroup: vi.fn(), sections: [], addSection: vi.fn(),
  }),
}))

const credDelete = vi.fn()
const credSave = vi.fn()

if (typeof window !== 'undefined') {
  ;(window as any).electronAPI = {
    debug: { isEnabled: vi.fn().mockResolvedValue(false) },
    dialog: { openFolder: vi.fn().mockResolvedValue(null) },
    credentials: { save: credSave, delete: credDelete },
  }
  ;(window as any).electronPlatform = 'win32'
}

import SessionDialog from '../../../src/renderer/components/SessionDialog'

function setValue(el: HTMLInputElement, value: string) {
  const proto = el.type === 'checkbox' ? null : Object.getPrototypeOf(el)
  const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value')?.set
  act(() => {
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function submit(container: HTMLElement) {
  const form = container.querySelector('form')!
  act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}

function byPlaceholder(container: HTMLElement, ph: string): HTMLInputElement | undefined {
  return Array.from(container.querySelectorAll('input')).find(
    (i) => (i as HTMLInputElement).placeholder?.includes(ph),
  ) as HTMLInputElement | undefined
}

const TERMINAL_LOCAL = {
  id: 'cfgT',
  provider: 'claude' as const,
  shellOnly: true,
  sessionType: 'local' as const,
  label: 'OpenClaw',
  workingDirectory: 'C:\\proj',
}

describe('SessionDialog terminal-only options', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    credDelete.mockClear(); credSave.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => { root.unmount() }); container.remove() })

  const render = (initial: any) => {
    const onConfirm = vi.fn()
    act(() => { root.render(React.createElement(SessionDialog, { initial, onConfirm, onCancel: vi.fn() })) })
    return onConfirm
  }

  it('renders the command / arguments / secret fields for a local Terminal-only config', () => {
    render(TERMINAL_LOCAL)
    expect(container.textContent).toContain('Terminal startup')
    expect(container.textContent).toContain('First-run command')
    expect(container.textContent).toContain('Arguments')
    expect(container.textContent).toContain('Secret argument')
    expect(container.textContent).toContain('Run as Administrator')
  })

  it('does NOT render them for a Claude Code config', () => {
    render({ ...TERMINAL_LOCAL, shellOnly: false })
    expect(container.textContent).not.toContain('First-run command')
    expect(container.textContent).not.toContain('Secret argument')
  })

  it('does NOT render them over SSH (the post-connect command owns that)', () => {
    render({
      ...TERMINAL_LOCAL, sessionType: 'ssh',
      sshConfig: { host: '10.0.0.5', port: 22, username: 'root', remotePath: '~' },
    })
    expect(container.textContent).not.toContain('First-run command')
    expect(container.textContent).toContain('After connecting, run')
  })

  it('persists command, args and elevated into config.terminalOptions', () => {
    const onConfirm = render(TERMINAL_LOCAL)
    setValue(byPlaceholder(container, 'npm run dev')!, 'openclaw')
    setValue(byPlaceholder(container, '--port 4310')!, '--serve {secret}')
    const elevate = Array.from(container.querySelectorAll('input[type="checkbox"]')).find(
      (c) => c.parentElement?.textContent?.includes('Run as Administrator'),
    ) as HTMLInputElement
    act(() => { elevate.click() })
    submit(container)
    expect(onConfirm).toHaveBeenCalledOnce()
    const [config] = onConfirm.mock.calls[0]
    expect(config.terminalOptions).toMatchObject({
      command: 'openclaw',
      args: '--serve {secret}',
      elevated: true,
    })
  })

  it('hands the secret to the caller for the keychain and keeps it OUT of the config', () => {
    const onConfirm = render(TERMINAL_LOCAL)
    setValue(byPlaceholder(container, 'npm run dev')!, 'openclaw')
    const secret = Array.from(container.querySelectorAll('input[type="password"]'))[0] as HTMLInputElement
    setValue(secret, 'sk-supersecret')
    submit(container)
    const [config, password, sudo, argSecret] = onConfirm.mock.calls[0]
    expect(argSecret).toBe('sk-supersecret')
    expect(password).toBeUndefined()
    expect(sudo).toBeUndefined()
    // Only the FLAG is persisted — never the value, anywhere in the config.
    expect(config.terminalOptions.hasSecretArg).toBe(true)
    expect(JSON.stringify(config)).not.toContain('sk-supersecret')
  })

  it('removing a stored secret deletes the keychain entry', () => {
    const onConfirm = render({ ...TERMINAL_LOCAL, terminalOptions: { command: 'openclaw', hasSecretArg: true } })
    const remove = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Remove')!
    act(() => { remove.click() })
    submit(container)
    const [config, , , argSecret] = onConfirm.mock.calls[0]
    expect(config.terminalOptions?.hasSecretArg).toBeUndefined()
    expect(argSecret).toBeUndefined()
    expect(credDelete).toHaveBeenCalledWith('cfgT_argsecret')
  })

  it('switching a terminal config to Claude Code deletes the orphaned secret', () => {
    const onConfirm = render({ ...TERMINAL_LOCAL, terminalOptions: { command: 'openclaw', hasSecretArg: true } })
    const claudeCard = container.querySelector('[role="radiogroup"][aria-label="Provider"] input[value="claude"]') as HTMLInputElement
    act(() => { claudeCard.click() })
    submit(container)
    expect(credDelete).toHaveBeenCalledWith('cfgT_argsecret')
    const [config] = onConfirm.mock.calls[0]
    expect(config.shellOnly).toBe(false)
  })
})
