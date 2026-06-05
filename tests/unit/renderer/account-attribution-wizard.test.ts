// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountAttributionWizard } from '../../../src/renderer/components/tokenomics/AccountAttributionWizard'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const sampleGroups = [
  { groupId: 'cfgA', groupLabel: 'This App Dev', sessionIds: ['s1','s2'], totalCostUsd: 12.34, suggestedEmail: 'a@x.com' },
  { groupId: 'cfgB', groupLabel: 'Windows Dev', sessionIds: ['s3'], totalCostUsd: 4.10, suggestedEmail: 'b@x.com' },
  { groupId: '__no-config__', groupLabel: '(no config)', sessionIds: ['s4'], totalCostUsd: 0.85, suggestedEmail: null },
]

beforeEach(() => {
  ;(globalThis as any).window = (globalThis as any).window ?? {}
  ;(globalThis as any).window.electronAPI = {
    tokenomics: {
      listUnattributed: vi.fn().mockResolvedValue(sampleGroups),
      // Copilot review on PR #31 (p9.14): wizard now also pulls the
      // full known-email list on mount so the <select> can offer options
      // when timeline suggestions are empty.
      listKnownEmails: vi.fn().mockResolvedValue(['a@x.com', 'b@x.com']),
      attributeSessions: vi.fn().mockResolvedValue({ ok: true }),
    },
  }
})

describe('AccountAttributionWizard', () => {
  let container: HTMLDivElement, root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  async function flush() { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

  // The wizard renders its rows (and their Confirm / Mark-mixed buttons) only
  // AFTER two async IPC calls (listUnattributed + listKnownEmails) resolve and
  // React re-renders. A single setTimeout(0) tick is racy under load and caused an
  // intermittent Windows-CI failure, so poll until the awaited DOM actually exists.
  async function waitFor(predicate: () => boolean, tries = 50) {
    for (let i = 0; i < tries; i++) {
      if (predicate()) return
      await act(async () => { await new Promise(r => setTimeout(r, 10)) })
    }
  }
  const buttonsByText = (label: string) =>
    Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter(b => b.textContent === label)

  it('renders one row per group with cost + suggested email', async () => {
    act(() => { root.render(createElement(AccountAttributionWizard, { onClose: () => {} })) })
    await waitFor(() => (container.textContent ?? '').includes('This App Dev'))
    expect(container.textContent).toContain('This App Dev')
    expect(container.textContent).toContain('Windows Dev')
    expect(container.textContent).toContain('a@x.com')
    expect(container.textContent).toContain('b@x.com')
    expect(container.textContent).toContain('$12.34')
  })

  it('warns that timeline suggestions can be wrong for concurrent accounts', async () => {
    act(() => { root.render(createElement(AccountAttributionWizard, { onClose: () => {} })) })
    await waitFor(() => (container.textContent ?? '').includes('This App Dev'))
    // The suggestion is inferred from a single global-login timeline, so it cannot be
    // correct for a config/session that ran multiple accounts at the same time. The
    // wizard must surface that limitation so the user verifies before applying.
    expect((container.textContent ?? '').toLowerCase()).toContain('concurrent')
  })

  it('Confirm fires attributeSessions with the suggested email', async () => {
    const onClose = vi.fn()
    act(() => { root.render(createElement(AccountAttributionWizard, { onClose })) })
    await waitFor(() => buttonsByText('Confirm').length > 0)
    const buttons = buttonsByText('Confirm')
    expect(buttons.length).toBeGreaterThan(0)
    act(() => { buttons[0].click() })
    await flush()
    expect((window as any).electronAPI.tokenomics.attributeSessions).toHaveBeenCalledWith({
      sessionIds: ['s1', 's2'],
      assignment: { type: 'email', email: 'a@x.com' },
    })
  })

  it('Mark mixed fires attributeSessions with mixed assignment', async () => {
    act(() => { root.render(createElement(AccountAttributionWizard, { onClose: () => {} })) })
    await waitFor(() => buttonsByText('Mark mixed').length > 0)
    const buttons = buttonsByText('Mark mixed')
    expect(buttons.length).toBeGreaterThan(0)
    act(() => { buttons[0].click() })
    await flush()
    expect((window as any).electronAPI.tokenomics.attributeSessions).toHaveBeenCalledWith({
      sessionIds: ['s1', 's2'],
      assignment: { type: 'mixed' },
    })
  })
})
