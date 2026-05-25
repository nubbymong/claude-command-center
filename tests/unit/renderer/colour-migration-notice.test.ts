// @vitest-environment jsdom
/**
 * Task 8 (V2 shell P2b2): one-time colour-migration notice.
 *
 * Uses React.createElement (not JSX) so the file stays under the vitest include
 * pattern (*.test.ts) -- matches sibling renderer component tests
 * (e.g. contextbar-account-slot.test.ts).
 *
 * Focus here: visibility (pending/dismissed gating) + the Dismiss action.
 * The Review colours target-picker logic is covered in
 * colour-review-target.test.ts.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Mutable settings the mocked store reads from, plus a spy for updateSettings.
const STATE: { settings: Record<string, unknown> } = { settings: {} }
const updateSettings = vi.fn(() => Promise.resolve())

vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (selector: (s: typeof STATE) => unknown) => selector(STATE)
  useSettingsStore.getState = () => ({ ...STATE, updateSettings })
  return { useSettingsStore }
})

// Review handler reads configs/sessions via getState; provide empty defaults.
vi.mock('../../../src/renderer/stores/configStore', () => {
  const useConfigStore: any = (selector: (s: any) => unknown) => selector({ configs: [] })
  useConfigStore.getState = () => ({ configs: [] })
  return { useConfigStore }
})
vi.mock('../../../src/renderer/stores/sessionStore', () => {
  const useSessionStore: any = (selector: (s: any) => unknown) => selector({ sessions: [] })
  useSessionStore.getState = () => ({ sessions: [] })
  return { useSessionStore }
})

const { default: ColourMigrationNotice } = await import(
  '../../../src/renderer/components/ColourMigrationNotice'
)

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (b) => b.textContent === label,
  )
}

describe('ColourMigrationNotice', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    STATE.settings = {}
    updateSettings.mockClear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  it('renders nothing when pending is false', () => {
    STATE.settings = { colourMigrationNoticePending: false }
    act(() => { root.render(React.createElement(ColourMigrationNotice, {})) })
    expect(container.textContent).toBe('')
  })

  it('renders nothing when pending && dismissed', () => {
    STATE.settings = { colourMigrationNoticePending: true, colourMigrationNoticeDismissed: true }
    act(() => { root.render(React.createElement(ColourMigrationNotice, {})) })
    expect(container.textContent).toBe('')
  })

  it('renders the title when pending && !dismissed', () => {
    STATE.settings = { colourMigrationNoticePending: true }
    act(() => { root.render(React.createElement(ColourMigrationNotice, {})) })
    expect(container.textContent).toContain('Session colours refreshed')
  })

  it('Dismiss persists colourMigrationNoticeDismissed: true', () => {
    STATE.settings = { colourMigrationNoticePending: true }
    act(() => { root.render(React.createElement(ColourMigrationNotice, {})) })
    const btn = findButton(container, 'Dismiss')
    expect(btn).toBeTruthy()
    act(() => { btn!.click() })
    expect(updateSettings).toHaveBeenCalledWith({ colourMigrationNoticeDismissed: true })
  })
})
