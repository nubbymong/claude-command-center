// @vitest-environment jsdom
// AiUsageSettings after the 2026-06-13 redesign: it shrank to JUST the
// "Included credits (USD)" cap input. The enable checkbox moved to the
// per-account aiCredits toggle (write-through to githubAiUsageEnabled) and the
// "Re-authorize GitHub" action moved into the account card. This locks that the
// duplicated enable + re-auth chrome is gone and the cap still persists.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import AiUsageSettings from '../../../src/renderer/components/github/config/AiUsageSettings'
import { useSettingsStore } from '../../../src/renderer/stores/settingsStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let updateSettingsSpy: ReturnType<typeof vi.spyOn>

// Drive a controlled <input> the way React expects: use the native value setter
// then dispatch a bubbling 'input' event so React's onChange fires.
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  updateSettingsSpy = vi
    .spyOn(useSettingsStore.getState(), 'updateSettings')
    .mockResolvedValue(undefined as never)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function render() {
  act(() => root.render(React.createElement(AiUsageSettings)))
}

describe('AiUsageSettings (shrunk to the cap input)', () => {
  it('renders only the Included credits (USD) input', () => {
    render()
    expect(container.textContent).toContain('Included credits (USD)')
    const number = container.querySelector('input[type="number"]')
    expect(number).not.toBeNull()
  })

  it('has NO enable checkbox and NO re-authorize button', () => {
    render()
    expect(container.querySelector('input[type="checkbox"]')).toBeNull()
    expect(container.textContent).not.toContain('Show Copilot AI-credits usage')
    const reauthBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      /re-author/i.test(b.textContent ?? ''),
    )
    expect(reauthBtn).toBeUndefined()
  })

  it('persists a numeric cap via updateSettings', () => {
    render()
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    typeInto(input, '20000')
    expect(updateSettingsSpy).toHaveBeenCalledWith({ copilotIncludedCredits: 20000 })
  })

  it('clears the cap to null on an empty input', () => {
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, copilotIncludedCredits: 20000 } }))
    render()
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    typeInto(input, '')
    expect(updateSettingsSpy).toHaveBeenCalledWith({ copilotIncludedCredits: null })
  })
})
