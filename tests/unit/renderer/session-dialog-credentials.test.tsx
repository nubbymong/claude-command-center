// @vitest-environment jsdom
/**
 * 2.1.0-beta.5 credential-hygiene regressions (adversarial review, #188).
 *
 * Every credential decision in SessionDialog must be gated on the FINAL
 * sessionType. Three MAJOR findings, each pinned here:
 *   1. Switching an SSH config to Local orphaned the stored secret (flag
 *      vanished, no keychain delete) — later auto-typed at a different host.
 *   2. A password typed into an SSH block that was then switched to Local was
 *      still written to the keychain for a config with no SSH.
 *   3. `hasPassword ?? true` default rendered the Save checkbox unticked for a
 *      key-auth config (which now persists hasPassword:false), silently
 *      dropping a freshly-typed password.
 * Plus the two validation gaps: the Codex×SSH combination and a '.' working
 * directory must both be unsaveable.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({
    groups: [],
    addGroup: vi.fn(),
    sections: [],
    addSection: vi.fn(),
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

// Provider/transport are native radios styled as cards: <label><input radio>.
// Return the input so .click() selects it.
function cardIn(container: HTMLElement, groupLabel: string, text: string): HTMLInputElement {
  const group = container.querySelector(`[role="radiogroup"][aria-label="${groupLabel}"]`)!
  const lab = Array.from(group.querySelectorAll('label')).find((l) => l.textContent?.startsWith(text))
  return lab!.querySelector('input[type="radio"]') as HTMLInputElement
}

function inputByPlaceholder(container: HTMLElement, ph: string): HTMLInputElement | undefined {
  return Array.from(container.querySelectorAll('input')).find(
    (i) => (i as HTMLInputElement).placeholder?.includes(ph),
  ) as HTMLInputElement | undefined
}

function saveCheckbox(container: HTMLElement, which = 0): HTMLInputElement | undefined {
  const boxes = Array.from(container.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[]
  const labelled = boxes.filter((b) => b.parentElement?.textContent?.includes('Save password'))
  return labelled[which]
}

const SSH_WITH_PW = {
  id: 'cfgAAA',
  provider: 'claude' as const,
  label: 'prod box',
  sessionType: 'ssh' as const,
  workingDirectory: '~',
  sshConfig: { host: '10.0.0.5', port: 22, username: 'root', remotePath: '~', hasPassword: true },
}

const SSH_KEY_AUTH = {
  id: 'cfgKEY',
  provider: 'claude' as const,
  label: 'key box',
  sessionType: 'ssh' as const,
  workingDirectory: '~',
  // The shape EVERY key-auth SSH config now saves as: hasPassword explicitly false.
  sshConfig: { host: '10.0.0.9', port: 22, username: 'root', remotePath: '~', hasPassword: false },
}

describe('SessionDialog credential hygiene (#188)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    credDelete.mockClear(); credSave.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => { root.unmount() }); container.remove() })

  it('F1: switching an SSH config with a stored password to Local deletes the secret and saves no SSH', () => {
    const onConfirm = vi.fn()
    act(() => { root.render(React.createElement(SessionDialog, { initial: SSH_WITH_PW, onConfirm, onCancel: vi.fn() })) })
    // Switch transport to Local, give it a valid absolute working directory.
    act(() => { cardIn(container, 'Where it runs', 'Local').click() })
    const wdir = inputByPlaceholder(container, ':\\')  // the win32 working-directory placeholder
    expect(wdir).toBeTruthy()
    setValue(wdir!, 'C:\\proj')
    submit(container)
    expect(onConfirm).toHaveBeenCalledOnce()
    const [config, password] = onConfirm.mock.calls[0]
    expect(config.sshConfig).toBeUndefined()
    expect(password).toBeUndefined()
    // The orphaned keychain entry is deleted on confirm.
    expect(credDelete).toHaveBeenCalledWith('cfgAAA')
  })

  it('F2: a password typed into SSH then abandoned by switching to Local is never saved', () => {
    const onConfirm = vi.fn()
    // New config.
    act(() => { root.render(React.createElement(SessionDialog, { onConfirm, onCancel: vi.fn() })) })
    act(() => { cardIn(container, 'Provider', 'Claude Code').click() })
    act(() => { cardIn(container, 'Where it runs', 'SSH').click() })
    setValue(inputByPlaceholder(container, '192.168')!, '10.0.0.5')
    const pw = Array.from(container.querySelectorAll('input[type="password"]'))[0] as HTMLInputElement
    setValue(pw, 'hunter2')
    // Change mind: switch to Local.
    act(() => { cardIn(container, 'Where it runs', 'Local').click() })
    setValue(inputByPlaceholder(container, ':\\')!, 'C:\\proj')
    const label = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).placeholder === 'e.g. App Dev') as HTMLInputElement
    setValue(label, 'oops')
    submit(container)
    expect(onConfirm).toHaveBeenCalledOnce()
    const [config, password] = onConfirm.mock.calls[0]
    expect(config.sshConfig).toBeUndefined()
    expect(password).toBeUndefined()  // the abandoned SSH password is NOT handed to the keychain
  })

  it('F3: typing a password into a key-auth (hasPassword:false) config saves it (checkbox defaults ticked)', () => {
    const onConfirm = vi.fn()
    act(() => { root.render(React.createElement(SessionDialog, { initial: SSH_KEY_AUTH, onConfirm, onCancel: vi.fn() })) })
    const pw = Array.from(container.querySelectorAll('input[type="password"]'))[0] as HTMLInputElement
    setValue(pw, 'newsecret')
    const box = saveCheckbox(container)!
    expect(box.checked).toBe(true)  // must default ticked, not `false ?? true` = false
    submit(container)
    const [config, password] = onConfirm.mock.calls[0]
    expect(config.sshConfig.hasPassword).toBe(true)
    expect(password).toBe('newsecret')
  })

  it('untick Save on a stored password still deletes the keychain entry (baseline held)', () => {
    const onConfirm = vi.fn()
    act(() => { root.render(React.createElement(SessionDialog, { initial: SSH_WITH_PW, onConfirm, onCancel: vi.fn() })) })
    const box = saveCheckbox(container)!
    expect(box.checked).toBe(true)
    act(() => { box.click() })
    submit(container)
    const [config, password] = onConfirm.mock.calls[0]
    expect(config.sshConfig.hasPassword).toBe(false)
    expect(password).toBeUndefined()
    expect(credDelete).toHaveBeenCalledWith('cfgAAA')
  })

  it('R2-F1: a label-only edit keeps the stored password and fires NO delete', () => {
    const onConfirm = vi.fn()
    act(() => { root.render(React.createElement(SessionDialog, { initial: SSH_WITH_PW, onConfirm, onCancel: vi.fn() })) })
    // Change only the label; leave host + password untouched.
    const label = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).value === 'prod box') as HTMLInputElement
    setValue(label, 'prod box renamed')
    submit(container)
    const [config, password] = onConfirm.mock.calls[0]
    expect(config.sshConfig.hasPassword).toBe(true)   // kept
    expect(password).toBeUndefined()                  // not re-sent (unchanged)
    // The main password key is preserved. The idempotent `_sudo` sweep may fire
    // (harmless orphan cleanup) — what must NOT happen is deleting the password.
    expect(credDelete).not.toHaveBeenCalledWith('cfgAAA')
  })

  it('R2-F2: changing the Host without retyping drops the stored password (not walked to a new host)', () => {
    const onConfirm = vi.fn()
    act(() => { root.render(React.createElement(SessionDialog, { initial: SSH_WITH_PW, onConfirm, onCancel: vi.fn() })) })
    const host = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).value === '10.0.0.5') as HTMLInputElement
    setValue(host, '203.0.113.9')  // repoint at a DIFFERENT machine
    submit(container)
    const [config, password] = onConfirm.mock.calls[0]
    expect(config.sshConfig.host).toBe('203.0.113.9')
    expect(config.sshConfig.hasPassword).toBe(false)  // old password does NOT carry
    expect(password).toBeUndefined()
    expect(credDelete).toHaveBeenCalledWith('cfgAAA') // old secret removed
  })

  it('R3: changing only the PORT drops the stored password (endpoint changed)', () => {
    const onConfirm = vi.fn()
    act(() => { root.render(React.createElement(SessionDialog, { initial: SSH_WITH_PW, onConfirm, onCancel: vi.fn() })) })
    const port = Array.from(container.querySelectorAll('input[type="number"]'))[0] as HTMLInputElement
    setValue(port, '2222')
    submit(container)
    const [config, password] = onConfirm.mock.calls[0]
    expect(config.sshConfig.hasPassword).toBe(false)
    expect(password).toBeUndefined()
    expect(credDelete).toHaveBeenCalledWith('cfgAAA')
  })

  it('R3: changing only the USERNAME drops the stored password (different principal)', () => {
    const onConfirm = vi.fn()
    act(() => { root.render(React.createElement(SessionDialog, { initial: SSH_WITH_PW, onConfirm, onCancel: vi.fn() })) })
    const user = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).value === 'root') as HTMLInputElement
    setValue(user, 'someoneelse')
    submit(container)
    const [config, password] = onConfirm.mock.calls[0]
    expect(config.sshConfig.hasPassword).toBe(false)
    expect(password).toBeUndefined()
    expect(credDelete).toHaveBeenCalledWith('cfgAAA')
  })

  it('R2-F3: the delete is idempotent — a non-saving edit always sweeps, regardless of the (possibly-lying) flag', () => {
    const onConfirm = vi.fn()
    // A config the OLD dialog left divergent: hasPassword:false but a secret is
    // actually live in the keychain. Editing + saving must still delete it.
    const DIVERGENT = { ...SSH_WITH_PW, id: 'cfgDIV', sshConfig: { ...SSH_WITH_PW.sshConfig, hasPassword: false } }
    act(() => { root.render(React.createElement(SessionDialog, { initial: DIVERGENT, onConfirm, onCancel: vi.fn() })) })
    submit(container)
    expect(credDelete).toHaveBeenCalledWith('cfgDIV')
    expect(credDelete).toHaveBeenCalledWith('cfgDIV_sudo')
  })
})

describe('SessionDialog validation gates (#188)', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => { act(() => { root.unmount() }); container.remove() })

  function saveBtn(): HTMLButtonElement {
    return Array.from(container.querySelectorAll('button')).find(
      (b) => /^(Create config|Save changes)$/.test(b.textContent?.trim() ?? ''),
    ) as HTMLButtonElement
  }

  it('a hand-edited Codex×SSH config cannot be saved', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(React.createElement(SessionDialog, {
        initial: { id: 'x', provider: 'codex', sessionType: 'ssh', label: 'bad', workingDirectory: '~',
          sshConfig: { host: '10.0.0.1', port: 22, username: 'root', remotePath: '~' } },
        onConfirm, onCancel: vi.fn(),
      }))
    })
    expect(saveBtn().disabled).toBe(true)
    expect(container.textContent).toContain("Codex can't run over SSH")
    submit(container)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("newly typing '.' as a working directory is rejected (transcript-misfiling incident)", () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(React.createElement(SessionDialog, {
        initial: { id: 'y', provider: 'claude', sessionType: 'local', label: 'dot', workingDirectory: 'C:\\proj' },
        onConfirm, onCancel: vi.fn(),
      }))
    })
    const wdir = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).value === 'C:\\proj') as HTMLInputElement
    setValue(wdir, '.')
    expect(saveBtn().disabled).toBe(true)
    expect(container.textContent).toContain('full path')
    submit(container)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('an UNCHANGED foreign-platform path stays editable (does not block unrelated edits)', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(React.createElement(SessionDialog, {
        // A macOS path opened on this Windows machine — the user is only renaming it.
        initial: { id: 'f', provider: 'claude', sessionType: 'local', label: 'mac', workingDirectory: '/Users/me/proj' },
        onConfirm, onCancel: vi.fn(),
      }))
    })
    expect(saveBtn().disabled).toBe(false)
    submit(container)
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('an absolute working directory saves fine', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(React.createElement(SessionDialog, {
        initial: { id: 'z', provider: 'claude', sessionType: 'local', label: 'ok', workingDirectory: 'C:\\proj' },
        onConfirm, onCancel: vi.fn(),
      }))
    })
    expect(saveBtn().disabled).toBe(false)
    submit(container)
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('rejects the ~evil shape-only lookalike when newly typed (not a real home path)', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(React.createElement(SessionDialog, {
        initial: { id: 'w', provider: 'claude', sessionType: 'local', label: 'x', workingDirectory: 'C:\\proj' },
        onConfirm, onCancel: vi.fn(),
      }))
    })
    const wdir = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).value === 'C:\\proj') as HTMLInputElement
    setValue(wdir, '~evil')
    expect(saveBtn().disabled).toBe(true)
    submit(container)
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('rejects an SSH remote directory with a space (would crash main at spawn)', () => {
    const onConfirm = vi.fn()
    act(() => {
      root.render(React.createElement(SessionDialog, {
        initial: {
          id: 'r', provider: 'claude', sessionType: 'ssh', label: 'x', workingDirectory: '/srv/my project',
          sshConfig: { host: '10.0.0.5', port: 22, username: 'root', remotePath: '/srv/my project' },
        },
        onConfirm, onCancel: vi.fn(),
      }))
    })
    expect(saveBtn().disabled).toBe(true)
    expect(container.textContent).toContain('Remote directory can only use')
    submit(container)
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
