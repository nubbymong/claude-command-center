// @vitest-environment jsdom
/**
 * P3.11 (row 62): the session dialog's Extra CLI arguments for Codex, driven
 * through the REAL dialog. The same field Claude's section has (one render:
 * the same label, help button, input and hint shape), saved as the config's
 * codexOptions.extraArgs as Claude's is saved as claudeOptions.extraArgs:
 * trimmed, and nothing for a blank. No check in the dialog, as Claude's field
 * has none: main refuses at launch (tests/unit/main/codex-extra-args-guard.test.ts).
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({ groups: [], addGroup: vi.fn(), sections: [], addSection: vi.fn() }),
}))

;(window as any).electronAPI = {
  debug: { isEnabled: vi.fn().mockResolvedValue(false) },
  dialog: { openFolder: vi.fn().mockResolvedValue(null) },
  credentials: { save: vi.fn(), delete: vi.fn() },
  legacyVersion: {
    fetchVersions: vi.fn().mockResolvedValue([]),
    isInstalled: vi.fn().mockResolvedValue(false),
    install: vi.fn().mockResolvedValue({ ok: true }),
    onInstallProgress: vi.fn().mockReturnValue(() => {}),
  },
}
;(window as any).electronPlatform = 'win32'

import SessionDialog from '../../../src/renderer/components/SessionDialog'
import { useProviderAccountsStore } from '../../../src/renderer/stores/providerAccountsStore'
import { snapshot } from './accounts-snapshot-harness'
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  useProviderAccountsStore.setState({ snapshot: snapshot({ externalDefaults: [{ providerId: 'codex', home: '~/.codex' }] }), loaded: true })
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, codexEnabled: true, codexAnswered: true } })
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function render(props: Record<string, unknown> = {}) {
  const onConfirm = vi.fn()
  act(() => { root.render(React.createElement(SessionDialog, { onConfirm, onCancel: vi.fn(), ...props } as any)) })
  return onConfirm
}
function card(group: string, title: string): HTMLInputElement {
  const g = container.querySelector(`[role="radiogroup"][aria-label="${group}"]`)!
  const lab = Array.from(g.querySelectorAll('label')).find((l) => l.querySelector('span')?.textContent === title)!
  return lab.querySelector('input[type="radio"]') as HTMLInputElement
}
function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => { setter.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true })) })
}
function newConfig(provider: 'Codex' | 'Claude Code'): ReturnType<typeof vi.fn> {
  const onConfirm = render()
  act(() => { card('Provider', provider).click() })
  act(() => { card('Connection', 'Local').click() })
  const wd = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).placeholder === 'C:\\path\\to\\project') as HTMLInputElement
  setInput(wd, 'C:\\proj')
  const label = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).placeholder === 'e.g. App Dev') as HTMLInputElement
  setInput(label, 'api-server')
  return onConfirm
}
const submit = () => act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
const saved = (onConfirm: ReturnType<typeof vi.fn>) => onConfirm.mock.calls[0][0]

/** The Extra CLI arguments field: its label, its help button and its input. */
function field() {
  const labels = Array.from(container.querySelectorAll('label')).filter((l) => l.textContent === 'Extra CLI arguments')
  expect(labels).toHaveLength(1)
  const row = labels[0].parentElement!
  const help = row.querySelector('button[aria-label="About extra CLI arguments"]') as HTMLButtonElement
  const input = row.parentElement!.querySelector('input[type="text"]') as HTMLInputElement
  return { row, help, input, box: row.parentElement! }
}

describe('a Codex config has Claude\'s Extra CLI arguments field (row 62)', () => {
  it('shows the same field, after the Permissions, and saves what is typed, trimmed', () => {
    const onConfirm = newCodexConfig()
    const f = field()
    expect(f.help).not.toBeNull()
    expect(f.input.className).toMatch(/font-mono/)
    const perms = container.querySelector('input[name="codex-permissions"]')!
    expect(perms.compareDocumentPosition(f.input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    setInput(f.input, '  --search --add-dir /srv/shared  ')
    submit()
    expect(saved(onConfirm).codexOptions.extraArgs).toBe('--search --add-dir /srv/shared')
    expect(saved(onConfirm).claudeOptions?.extraArgs).toBeUndefined()
  })

  it('saves nothing for a blank field', () => {
    const onConfirm = newCodexConfig()
    setInput(field().input, '   ')
    submit()
    expect(saved(onConfirm).codexOptions.extraArgs).toBeUndefined()
  })

  it('an edit reopens what is stored and keeps it', () => {
    const onConfirm = render({ initial: { id: 'c1', provider: 'codex', sessionType: 'local', label: 'x', workingDirectory: 'C:\\proj', color: '', codexOptions: { permissionsPreset: 'auto', extraArgs: '--no-alt-screen' } } })
    expect(field().input.value).toBe('--no-alt-screen')
    submit()
    expect(saved(onConfirm).codexOptions).toEqual({ permissionsPreset: 'auto', extraArgs: '--no-alt-screen' })
  })

  it('its help says each word is one argument, and what the app refuses', () => {
    newCodexConfig()
    const f = field()
    act(() => { f.help.click() })
    const hint = f.box.querySelector('p')!.textContent!
    expect(hint).toMatch(/one argument/i)
    expect(hint).toMatch(/--model/)
    expect(hint).toMatch(/-c/)
    expect(hint).toMatch(/--sandbox/)
    expect(hint).toMatch(/--cd/)
    expect(hint).toMatch(/--profile/)
    expect(hint).toMatch(/account, provider or endpoint/)
    expect(hint).toMatch(/command/)
  })

  function newCodexConfig() { return newConfig('Codex') }
})

describe('Claude\'s field is the same field, and unchanged', () => {
  it('saves claudeOptions.extraArgs as before, and a Codex config never inherits it', () => {
    const onConfirm = render({ initial: { id: 'c2', provider: 'claude', sessionType: 'local', label: 'x', workingDirectory: 'C:\\proj', color: '', claudeOptions: { extraArgs: '--verbose' } } })
    const f = field()
    expect(f.input.value).toBe('--verbose')
    expect(f.input.placeholder).toBe('--verbose --add-dir F:\\shared_libs')
    setInput(f.input, ' --verbose --add-dir docs ')
    submit()
    expect(saved(onConfirm).claudeOptions.extraArgs).toBe('--verbose --add-dir docs')
    expect(saved(onConfirm).codexOptions).toBeUndefined()
  })

  it('both sections render the one field: the same label, help button and input', () => {
    newConfig('Claude Code')
    const claude = field()
    const claudeShape = { label: claude.row.outerHTML, input: claude.input.className }
    setInput(claude.input, '--verbose')
    act(() => { card('Provider', 'Codex').click() })
    const codex = field()
    expect(codex.row.outerHTML.replace(/xargs-cx/g, 'xargs')).toBe(claudeShape.label)
    expect(codex.input.className).toBe(claudeShape.input)
    // What was typed for one assistant stays with it.
    expect(codex.input.value).toBe('')
  })
})
