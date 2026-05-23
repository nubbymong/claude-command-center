// @vitest-environment jsdom
import { createElement } from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { EditAttributionMenu } from '../../../src/renderer/components/tokenomics/EditAttributionMenu'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
beforeEach(() => {
  ;(globalThis as any).window = (globalThis as any).window ?? {}
  ;(globalThis as any).window.electronAPI = {
    tokenomics: { attributeSessions: vi.fn().mockResolvedValue({ ok: true }) },
  }
})

describe('EditAttributionMenu', () => {
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

  it('renders detected emails as options + Mixed + Clear', () => {
    act(() => { root.render(createElement(EditAttributionMenu, { sessionId: 's1', detectedEmails: ['a@x.com', 'b@x.com'], onChange: () => {} })) })
    const opts = Array.from(container.querySelectorAll('option')).map(o => o.value)
    expect(opts).toContain('a@x.com')
    expect(opts).toContain('b@x.com')
    expect(opts).toContain('__mixed__')
    expect(opts).toContain('__clear__')
  })

  it('selecting an email fires attributeSessions with single-record payload', async () => {
    const onChange = vi.fn()
    act(() => { root.render(createElement(EditAttributionMenu, { sessionId: 's1', detectedEmails: ['a@x.com'], onChange })) })
    const select = container.querySelector('select')!
    act(() => { select.value = 'a@x.com'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await new Promise(r => setTimeout(r, 0))
    expect((window as any).electronAPI.tokenomics.attributeSessions).toHaveBeenCalledWith({
      sessionIds: ['s1'],
      assignment: { type: 'email', email: 'a@x.com' },
    })
  })

  // Copilot review on PR #31 (p9.9): the IPC call may fail; the previous
  // implementation fired onChange unconditionally so the UI refreshed as
  // if the edit landed. Pin the corrected behaviour.
  it('does NOT call onChange when attributeSessions returns ok=false', async () => {
    ;(window as any).electronAPI.tokenomics.attributeSessions = vi.fn().mockResolvedValue({
      ok: false,
      error: 'main-side rejected',
    })
    const onChange = vi.fn()
    act(() => { root.render(createElement(EditAttributionMenu, { sessionId: 's1', detectedEmails: ['a@x.com'], onChange })) })
    const select = container.querySelector('select')!
    act(() => { select.value = 'a@x.com'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await new Promise(r => setTimeout(r, 0))
    // Wait one more microtask flush for setState to apply.
    await act(async () => { await new Promise(r => setTimeout(r, 0)) })
    expect(onChange).not.toHaveBeenCalled()
    // Error indicator surfaces inline so the user knows the edit failed.
    const alert = container.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert?.getAttribute('title')).toContain('main-side rejected')
  })
})
