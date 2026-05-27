// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/hooks/useThemeController', () => ({
  useResolvedTheme: () => 'dark',
}))
vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: vi.fn().mockResolvedValue(undefined),
  saveConfigDebounced: vi.fn(),
}))

const { default: AccountColoursSection } = await import('../../../src/renderer/components/settings/AccountColoursSection')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, isLoaded: true } as any)
  ;(window as any).electronAPI = {
    tokenomics: { listKnownEmails: vi.fn().mockResolvedValue(['detected@x.com']) },
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
function renderSection() { act(() => { root.render(createElement(AccountColoursSection)) }) }

function setSelect(el: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  setter.call(el, value)
  act(() => { el.dispatchEvent(new Event('change', { bubbles: true })) })
}
function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  act(() => { el.dispatchEvent(new Event('input', { bubbles: true })) })
}
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`)

describe('AccountColoursSection', () => {
  it('lists detected accounts from listKnownEmails', async () => {
    renderSection(); await flush()
    expect(container.textContent).toContain('detected@x.com')
  })

  it('persists an override when a swatch is chosen', async () => {
    renderSection(); await flush()
    setSelect(byTestId('swatch-detected@x.com') as HTMLSelectElement, 'rose')
    expect(useSettingsStore.getState().settings.accountColourOverrides?.['detected@x.com']).toBe('rose')
  })

  it('removes the override when Auto is chosen', async () => {
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, accountColourOverrides: { 'detected@x.com': 'rose' } }, isLoaded: true,
    } as any)
    renderSection(); await flush()
    setSelect(byTestId('swatch-detected@x.com') as HTMLSelectElement, '__auto__')
    expect(useSettingsStore.getState().settings.accountColourOverrides?.['detected@x.com']).toBeUndefined()
  })

  it('adds a manually-typed email (canonicalised) as an override', async () => {
    renderSection(); await flush()
    setInput(byTestId('add-email-input') as HTMLInputElement, '  New@Y.COM ')
    setSelect(byTestId('add-email-swatch') as HTMLSelectElement, 'indigo')
    act(() => { (byTestId('add-email-btn') as HTMLButtonElement).click() })
    expect(useSettingsStore.getState().settings.accountColourOverrides?.['new@y.com']).toBe('indigo')
  })

  it('rejects an invalid email', async () => {
    renderSection(); await flush()
    setInput(byTestId('add-email-input') as HTMLInputElement, 'notanemail')
    act(() => { (byTestId('add-email-btn') as HTMLButtonElement).click() })
    expect(byTestId('add-email-error')).toBeTruthy()
    expect(useSettingsStore.getState().settings.accountColourOverrides ?? {}).toEqual({})
  })
})
