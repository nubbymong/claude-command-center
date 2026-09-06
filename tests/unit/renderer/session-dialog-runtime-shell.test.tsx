// @vitest-environment jsdom
/**
 * rc.15 review R1 (aicc_planning#45): the container runtime's "Shell inside"
 * control. A config converted from a legacy `... sh` line keeps sh (a sh-only
 * image has no bash to exec); the control lets the user go back to bash, so a
 * converted config is not stuck on sh with no way out (review round 2). It is
 * hidden for Start mode, where the attach uses no shell at all (round 3), and
 * only `sh` is persisted -- bash is the default and is written as undefined.
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

if (typeof window !== 'undefined') {
  ;(window as any).electronAPI = {
    debug: { isEnabled: vi.fn().mockResolvedValue(false) },
    dialog: { openFolder: vi.fn().mockResolvedValue(null) },
    credentials: { save: vi.fn(), delete: vi.fn() },
  }
  ;(window as any).electronPlatform = 'win32'
}

import SessionDialog from '../../../src/renderer/components/SessionDialog'

const containerConfig = (runtime: Record<string, unknown>) => ({
  id: 'cfgC',
  provider: 'claude' as const,
  sessionType: 'ssh' as const,
  label: 'review box',
  workingDirectory: '~',
  sshConfig: {
    host: '10.0.0.5', port: 22, username: 'root', remotePath: '~',
    runtime: { type: 'container', engine: 'podman', container: 'review', ...runtime },
  },
})

function choose(el: HTMLSelectElement, value: string) {
  act(() => {
    el.value = value
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function submit(container: HTMLElement) {
  const form = container.querySelector('form')!
  act(() => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
}

describe('SessionDialog container runtime: the shell inside the container', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
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
  const shellSelect = () => container.querySelector('[data-testid="runtime-shell"]') as HTMLSelectElement | null

  it('shows the saved sh, and switching back to bash persists no shell (bash is the default)', () => {
    const onConfirm = render(containerConfig({ shell: 'sh' }))
    const sel = shellSelect()
    expect(sel).not.toBeNull()
    expect(sel!.value).toBe('sh')
    choose(sel!, 'bash')
    submit(container)
    expect(onConfirm).toHaveBeenCalledOnce()
    const [config] = onConfirm.mock.calls[0]
    expect(config.sshConfig.runtime.container).toBe('review')
    expect(config.sshConfig.runtime.shell).toBeUndefined()
  })

  it('defaults to bash and persists sh when chosen', () => {
    const onConfirm = render(containerConfig({}))
    const sel = shellSelect()
    expect(sel!.value).toBe('bash')
    choose(sel!, 'sh')
    submit(container)
    const [config] = onConfirm.mock.calls[0]
    expect(config.sshConfig.runtime.shell).toBe('sh')
  })

  it('is hidden for Start mode, where the attach runs no shell', () => {
    render(containerConfig({ mode: 'start', shell: 'sh' }))
    expect(shellSelect()).toBeNull()
    expect(container.querySelector('[data-testid="runtime-container-name"]')).not.toBeNull()
  })
})
