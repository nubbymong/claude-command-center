// @vitest-environment jsdom
/**
 * P3.12 (row 31): the session dialog's "Index conversation logs" checkbox for
 * Codex, driven through the REAL dialog. One field for both assistants (one
 * render: the same label, help button and checkbox), saved as the config's
 * codexOptions.loggingEnabled (claudeOptions.loggingEnabled for Claude Code):
 * default on (nothing written), false when turned off. Its hint names where
 * each assistant keeps the conversation either way.
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

/** The one "Index conversation logs" field: its row, checkbox and help button. */
function field() {
  const labels = Array.from(container.querySelectorAll('label')).filter((l) => l.textContent?.trim() === 'Index conversation logs')
  expect(labels).toHaveLength(1)
  const row = labels[0].parentElement!
  const box = labels[0].querySelector('input[type="checkbox"]') as HTMLInputElement
  const help = row.querySelector('button[aria-label="About conversation logs"]') as HTMLButtonElement
  return { row, box, help, wrap: row.parentElement! }
}

describe('a Codex config has the "Index conversation logs" checkbox (P3.12, row 31)', () => {
  it('on by default, nothing written; turned off, codexOptions.loggingEnabled is false and Claude\'s field is not touched', () => {
    const a = newConfig('Codex')
    expect(field().box.checked).toBe(true)
    submit()
    expect(saved(a).codexOptions.loggingEnabled).toBeUndefined()
    act(() => { root.unmount() })
    root = createRoot(container)
    const b = newConfig('Codex')
    act(() => { field().box.click() })
    submit()
    expect(saved(b).codexOptions.loggingEnabled).toBe(false)
    expect(saved(b).claudeOptions?.loggingEnabled).toBeUndefined()
  })

  it('an edit reopens what is stored and keeps it', () => {
    const onConfirm = render({ initial: { id: 'c1', provider: 'codex', sessionType: 'local', label: 'x', workingDirectory: 'C:\\proj', color: '', codexOptions: { permissionsPreset: 'auto', loggingEnabled: false } } })
    expect(field().box.checked).toBe(false)
    submit()
    expect(saved(onConfirm).codexOptions).toEqual({ permissionsPreset: 'auto', loggingEnabled: false })
  })

  it('its hint names where Codex keeps the conversation either way, not Claude\'s folder', () => {
    newConfig('Codex')
    const f = field()
    act(() => { f.help.click() })
    const hint = f.wrap.querySelector('p')!.textContent!
    expect(hint).toMatch(/Codex/)
    expect(hint).toMatch(/sessions folder/)
    expect(hint).not.toMatch(/\.claude/)
  })

  it('both sections render the one field: the same row, and what is set for one assistant stays with it', () => {
    newConfig('Claude Code')
    const claudeRow = field().row.outerHTML
    act(() => { field().box.click() })
    act(() => { card('Provider', 'Codex').click() })
    // The markup alike, whatever each checkbox says (React writes checked at mount).
    const shape = (html: string) => html.replace(/logs-cx/g, 'logs').replace(/s*checked=""/g, '')
    expect(shape(field().row.outerHTML)).toBe(shape(claudeRow))
    expect(field().box.checked).toBe(true)
  })
})
