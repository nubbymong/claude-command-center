// @vitest-environment jsdom
/**
 * MultiAccountGate -- unit tests.
 *
 * Verifies:
 *   - stage 'ask' renders the question heading, the warning text, and the defaultEmail.
 *   - exactly the two action buttons exist in 'ask'; Enable -> onEnable, No thanks -> onDecline.
 *   - clicking the backdrop calls NEITHER callback (non-dismissible).
 *   - after Enable, stage becomes 'manage' and AccountsPanel content
 *     ("Add another account") is present.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useAccountProfilesStore } from '../../../src/renderer/stores/accountProfilesStore'
import { useSettingsStore } from '../../../src/renderer/stores/settingsStore'
import type { AccountProfile } from '../../../src/shared/account-types'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// ---------------------------------------------------------------------------
// Electron API mock (AccountsPanel reads window.electronAPI.accountProfiles)

const listMock = vi.fn<[], Promise<AccountProfile[]>>()
const globalEmailMock = vi.fn<[], Promise<string | null>>()

;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  accountProfiles: {
    list: listMock,
    globalEmail: globalEmailMock,
    create: vi.fn(),
    rename: vi.fn(),
    delete: vi.fn(),
    refreshIdentity: vi.fn(),
  },
}

// ---------------------------------------------------------------------------
// Minimal render helper (same pattern as accounts-panel.test.tsx)

function renderComponent(ui: React.ReactElement): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  act(() => { root.render(ui) })
  return {
    container,
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

// ---------------------------------------------------------------------------
// Import component AFTER mocks

const { default: MultiAccountGate } = await import('../../../src/renderer/components/MultiAccountGate')

// ---------------------------------------------------------------------------

function makeProps(overrides: Partial<React.ComponentProps<typeof MultiAccountGate>> = {}) {
  return {
    defaultEmail: 'me@example.com' as string | null,
    changedTo: null as string | null | undefined,
    onEnable: vi.fn(),
    onDecline: vi.fn(),
    onAdd: vi.fn(),
    onDone: vi.fn(),
    ...overrides,
  }
}

describe('MultiAccountGate', () => {
  let unmount: () => void

  beforeEach(() => {
    useAccountProfilesStore.setState({ profiles: [] })
    useSettingsStore.setState((s) => ({
      ...s,
      settings: { ...s.settings, accountAliases: {} },
    }))
    listMock.mockResolvedValue([])
    globalEmailMock.mockResolvedValue(null)
  })

  afterEach(() => {
    unmount?.()
    vi.clearAllMocks()
  })

  it('renders the question heading, the warning text, and the defaultEmail in stage ask', () => {
    const props = makeProps()
    const { container, unmount: u } = renderComponent(
      React.createElement(MultiAccountGate, props)
    )
    unmount = u

    expect(container.textContent).toContain('Run multiple Claude accounts?')
    const warning = container.querySelector('[data-testid="account-gate-warning"]')
    expect(warning).toBeTruthy()
    expect(warning!.textContent).toContain('each profile')
    expect(container.textContent).toContain('me@example.com')
    // No em dashes anywhere in the rendered gate (project rule).
    expect(container.textContent).not.toContain('—')
  })

  it('rewords the heading when changedTo is set', () => {
    const props = makeProps({ changedTo: 'new@corp.com' })
    const { container, unmount: u } = renderComponent(
      React.createElement(MultiAccountGate, props)
    )
    unmount = u

    expect(container.textContent).toContain('Your Claude account changed to new@corp.com')
  })

  it('has exactly the two action buttons in stage ask; Enable calls onEnable, No thanks calls onDecline', async () => {
    const props = makeProps()
    const { container, unmount: u } = renderComponent(
      React.createElement(MultiAccountGate, props)
    )
    unmount = u

    const dialog = container.querySelector('[data-testid="account-gate-dialog"]')!
    const buttons = dialog.querySelectorAll('button')
    expect(buttons.length).toBe(2)

    const enable = container.querySelector('[data-testid="account-gate-enable"]') as HTMLButtonElement
    const decline = container.querySelector('[data-testid="account-gate-decline"]') as HTMLButtonElement
    expect(enable).toBeTruthy()
    expect(decline).toBeTruthy()

    await act(async () => { decline.click() })
    expect(props.onDecline).toHaveBeenCalledOnce()
    expect(props.onEnable).not.toHaveBeenCalled()
  })

  it('clicking Enable calls onEnable', async () => {
    const props = makeProps()
    const { container, unmount: u } = renderComponent(
      React.createElement(MultiAccountGate, props)
    )
    unmount = u

    const enable = container.querySelector('[data-testid="account-gate-enable"]') as HTMLButtonElement
    await act(async () => { enable.click() })
    expect(props.onEnable).toHaveBeenCalledOnce()
  })

  it('clicking the backdrop does NOT call onDecline or onEnable (not dismissible)', async () => {
    const props = makeProps()
    const { container, unmount: u } = renderComponent(
      React.createElement(MultiAccountGate, props)
    )
    unmount = u

    const backdrop = container.querySelector('[data-testid="account-gate-backdrop"]') as HTMLElement
    expect(backdrop).toBeTruthy()
    await act(async () => { backdrop.click() })
    expect(props.onDecline).not.toHaveBeenCalled()
    expect(props.onEnable).not.toHaveBeenCalled()
  })

  it('after clicking Enable the stage becomes manage and AccountsPanel content is present', async () => {
    const props = makeProps()
    const { container, unmount: u } = renderComponent(
      React.createElement(MultiAccountGate, props)
    )
    unmount = u

    const enable = container.querySelector('[data-testid="account-gate-enable"]') as HTMLButtonElement
    await act(async () => { enable.click() })

    // AccountsPanel renders its "Add another account" affordance + a Done button.
    expect(container.querySelector('[data-testid="add-account-btn"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="account-gate-done"]')).toBeTruthy()
    expect(container.textContent).toContain('Add another account')
  })
})
