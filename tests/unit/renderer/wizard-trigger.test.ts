// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { WizardTrigger } from '../../../src/renderer/components/tokenomics/WizardTrigger'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
  ;(globalThis as any).window = (globalThis as any).window ?? {}
  ;(globalThis as any).window.electronAPI = {
    tokenomics: {
      listUnattributed: vi.fn().mockResolvedValue([
        { groupId: 'a', groupLabel: 'A', sessionIds: ['s1'], totalCostUsd: 1, suggestedEmail: null },
      ]),
      attributeSessions: vi.fn().mockResolvedValue({ ok: true }),
    },
  }
})

describe('WizardTrigger', () => {
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

  it('renders a banner when unattributed sessions exist and dismissed=false', async () => {
    act(() => { root.render(createElement(WizardTrigger, { dismissed: false, onDismiss: () => {} })) })
    await new Promise(r => setTimeout(r, 0))
    expect(container.textContent).toContain('Sessions needing account attribution')
  })

  it('does not render when dismissed=true', async () => {
    act(() => { root.render(createElement(WizardTrigger, { dismissed: true, onDismiss: () => {} })) })
    await new Promise(r => setTimeout(r, 0))
    expect(container.textContent).toBe('')
  })

  it('does not render when unattributed list is empty', async () => {
    ;(window as any).electronAPI.tokenomics.listUnattributed = vi.fn().mockResolvedValue([])
    act(() => { root.render(createElement(WizardTrigger, { dismissed: false, onDismiss: () => {} })) })
    await new Promise(r => setTimeout(r, 0))
    expect(container.textContent).toBe('')
  })
})
