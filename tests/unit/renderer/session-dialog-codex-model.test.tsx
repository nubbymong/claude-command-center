// @vitest-environment jsdom
/**
 * P3.8 (rows 39, 40): the session dialog's Codex Model and Reasoning effort,
 * driven through the REAL dialog, as Claude's Starting model and effort are:
 *
 *  - the model list is the registry's Codex catalogue (the supported Codex
 *    CLI's own picker), with Default (Codex's own choice) first;
 *  - the effort list is Codex's levels, the ones the chosen model does not
 *    support disabled, and a model change drops an effort the new model cannot
 *    run to Default (never submits it);
 *  - an edit keeps what is stored: a config saved with no model or effort
 *    reopens as Default and saves nothing, a saved model the list no longer
 *    offers is shown and kept, and a saved effort its model cannot run (a
 *    legacy 'minimal') is dropped on load, as Claude's effort is.
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
}
;(window as any).electronPlatform = 'win32'

import SessionDialog from '../../../src/renderer/components/SessionDialog'
import { useProviderAccountsStore } from '../../../src/renderer/stores/providerAccountsStore'
import { snapshot } from './accounts-snapshot-harness'
import { useSettingsStore, DEFAULT_SETTINGS } from '../../../src/renderer/stores/settingsStore'
import { useRegistryStore } from '../../../src/renderer/stores/registryStore'

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

function choose(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  act(() => { setter.call(el, value); el.dispatchEvent(new Event('change', { bubbles: true })) })
}

function newCodexConfig(): ReturnType<typeof vi.fn> {
  const onConfirm = render()
  act(() => { card('Provider', 'Codex').click() })
  act(() => { card('Connection', 'Local').click() })
  const wd = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).placeholder === 'C:\\path\\to\\project') as HTMLInputElement
  setInput(wd, 'C:\\proj')
  const label = Array.from(container.querySelectorAll('input')).find((i) => (i as HTMLInputElement).placeholder === 'e.g. App Dev') as HTMLInputElement
  setInput(label, 'api-server')
  return onConfirm
}

const modelSel = () => container.querySelector('[data-testid="codex-model-select"]') as HTMLSelectElement
const effortSel = () => container.querySelector('[data-testid="codex-effort-select"]') as HTMLSelectElement
const options = (s: HTMLSelectElement) => Array.from(s.options).map((o) => ({ value: o.value, text: o.textContent, disabled: o.disabled }))
const submit = () => act(() => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
const saved = (onConfirm: ReturnType<typeof vi.fn>) => onConfirm.mock.calls[0][0].codexOptions

const edit = (codexOptions: Record<string, unknown>) =>
  render({ initial: { id: 'c1', provider: 'codex', sessionType: 'local', label: 'x', workingDirectory: 'C:\\proj', color: '', codexOptions } })

describe("the Codex model list is the registry's catalogue (row 39)", () => {
  it('offers Default and the Codex CLI catalogue, a new config starting on gpt-5.5 at medium as before', () => {
    const onConfirm = newCodexConfig()
    expect(options(modelSel()).map((o) => o.value)).toEqual(['', 'gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.2'])
    expect(options(modelSel())[0].text).toBe('Default: follows Codex')
    expect(modelSel().value).toBe('gpt-5.5')
    expect(effortSel().value).toBe('medium')
    submit()
    expect(saved(onConfirm)).toEqual({ model: 'gpt-5.5', reasoningEffort: 'medium', permissionsPreset: 'standard' })
  })

  it('Default saves no model, so Codex chooses', () => {
    const onConfirm = newCodexConfig()
    choose(modelSel(), '')
    submit()
    expect(saved(onConfirm).model).toBeUndefined()
  })
})

describe('Codex efforts per model (row 40)', () => {
  it("lists Codex's levels with the ones the model lacks disabled", () => {
    newCodexConfig()
    expect(options(effortSel()).map((o) => o.value)).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
    expect(options(effortSel()).filter((o) => o.disabled).map((o) => o.value)).toEqual(['max', 'ultra'])
    choose(modelSel(), 'gpt-6-astra')
    expect(options(effortSel()).some((o) => o.disabled)).toBe(false)
  })

  it('a model change drops an effort the new model cannot run to Default, and never submits it', () => {
    const onConfirm = newCodexConfig()
    choose(modelSel(), 'gpt-6-astra')
    choose(effortSel(), 'ultra')
    expect(effortSel().value).toBe('ultra')
    choose(modelSel(), 'gpt-5.5')
    expect(effortSel().value).toBe('')
    submit()
    expect(saved(onConfirm)).toEqual({ model: 'gpt-5.5', reasoningEffort: undefined, permissionsPreset: 'standard' })
  })

  it('a model change keeps an effort the new model can run', () => {
    const onConfirm = newCodexConfig()
    choose(effortSel(), 'xhigh')
    choose(modelSel(), 'gpt-5.6-luna')
    submit()
    expect(saved(onConfirm).reasoningEffort).toBe('xhigh')
  })
})

describe('an edit keeps what is stored', () => {
  it('no saved model or effort reopens as Default and saves none (never rewritten to gpt-5.5 / medium)', () => {
    const onConfirm = edit({ permissionsPreset: 'auto' })
    expect(modelSel().value).toBe('')
    expect(effortSel().value).toBe('')
    submit()
    expect(saved(onConfirm)).toEqual({ model: undefined, reasoningEffort: undefined, permissionsPreset: 'auto' })
  })

  it('an effort the registry stops offering for the model after the dialog opened is dropped on save', () => {
    const before = useRegistryStore.getState().registry
    try {
      const onConfirm = edit({ model: 'gpt-6-astra', reasoningEffort: 'ultra', permissionsPreset: 'standard' })
      expect(effortSel().value).toBe('ultra')
      // A registry reload (hydrate or an overlay) narrows gpt-6-astra's levels.
      const narrowed = { ...before, models: before.models.map((m) => (m.id === 'gpt-6-astra' ? { ...m, efforts: ['low', 'medium'] } : m)) }
      act(() => { useRegistryStore.setState({ registry: narrowed }) })
      submit()
      expect(saved(onConfirm).reasoningEffort).toBeUndefined()
    } finally {
      useRegistryStore.setState({ registry: before })
    }
  })

  it('a saved model the list no longer offers is shown as saved and kept', () => {
    const onConfirm = edit({ model: 'gpt-5.3-codex', reasoningEffort: 'high', permissionsPreset: 'standard' })
    expect(modelSel().value).toBe('gpt-5.3-codex')
    expect(options(modelSel()).find((o) => o.value === 'gpt-5.3-codex')!.text).toBe('gpt-5.3-codex (not in the list)')
    submit()
    expect(saved(onConfirm)).toEqual({ model: 'gpt-5.3-codex', reasoningEffort: 'high', permissionsPreset: 'standard' })
  })

  it('a saved effort its model cannot run (a legacy minimal, or ultra on gpt-5.5) is dropped on load', () => {
    for (const reasoningEffort of ['minimal', 'ultra', 'none']) {
      const onConfirm = edit({ model: 'gpt-5.5', reasoningEffort, permissionsPreset: 'standard' })
      expect(effortSel().value, reasoningEffort).toBe('')
      submit()
      expect(saved(onConfirm).reasoningEffort, reasoningEffort).toBeUndefined()
      act(() => { root.unmount() })
      root = createRoot(container)
    }
  })
})
