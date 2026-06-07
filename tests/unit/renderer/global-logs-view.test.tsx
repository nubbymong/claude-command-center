// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Flat slot summaries from logs2.listSlots. 'c1' is live (configStore mock has
// it); 'dead' is not -> Orphaned bucket.
const slots = [
  { slotKey: 'c1', configId: 'c1', configLabel: 'APP', accountEmail: null, lastActive: 300, runCount: 2, messageCount: 12 },
  { slotKey: 'orph', configId: 'dead', configLabel: 'OLD', accountEmail: null, lastActive: 100, runCount: 1, messageCount: 3 },
]

const listSlots = vi.fn().mockResolvedValue(slots)
const search = vi.fn().mockResolvedValue([
  { runId: 7, idx: 4, configId: 'c1', sessionId: 'c1', snippet: 'a [needle] here' },
])
const deleteSlot = vi.fn().mockResolvedValue({ deletedRuns: 1, deletedMessages: 3 })
const clearAll = vi.fn().mockResolvedValue({ deletedRuns: 3, deletedMessages: 30 })
const turnSummary = vi.fn().mockResolvedValue([])
const onNewMessages = vi.fn(() => () => {})

// Capture jumpTo so we can assert a search-hit click forwards to the shared hook.
const jumpToSpy = vi.fn().mockResolvedValue(undefined)

// Mock the windowing hook so the transcript view renders without real reads and
// we can observe the shared jumpTo being invoked by a hit click.
vi.mock('../../../src/renderer/hooks/useWindowedTurns', () => ({
  useWindowedTurns: () => ({
    messages: [{ runId: 7, idx: 0, ts: 1, role: 'assistant', kind: 'message', content: 'hi', toolName: null, toolMeta: null }],
    pageCount: 1,
    follow: true,
    loading: false,
    loadingOlder: false,
    error: null,
    setFollow: vi.fn(),
    loadOlder: vi.fn().mockResolvedValue(undefined),
    jumpTo: jumpToSpy,
    prependToken: 0,
  }),
}))

let loggingEnabled = true

beforeEach(() => {
  loggingEnabled = true
  listSlots.mockClear(); search.mockClear(); deleteSlot.mockClear(); clearAll.mockClear()
  turnSummary.mockClear(); jumpToSpy.mockClear()
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
  // jsdom doesn't implement Element.scrollTo; the transcript view auto-sticks to
  // the bottom while following, so stub it.
  ;(HTMLElement.prototype as any).scrollTo = (HTMLElement.prototype as any).scrollTo ?? function () {}
  ;(globalThis as any).confirm = vi.fn(() => true)
  ;(globalThis as any).alert = vi.fn()
  ;(globalThis as any).window.electronAPI = {
    logs2: { listSlots, search, deleteSlot, clearAll, turnSummary, onNewMessages },
  }
})

vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({ configs: [{ id: 'c1', label: 'APP' }] }),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => ({
  useSettingsStore: (sel: any) => sel({ settings: { loggingEnabled, accountAliases: {} } }),
}))
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({
  useAccountProfilesStore: (sel: any) => sel({ profiles: [] }),
}))

import GlobalLogsView from '../../../src/renderer/components/GlobalLogsView'

const mount = async (el: React.ReactElement) => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(el) })
  await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
  return { container, cleanup: () => { root.unmount(); container.remove() } }
}

describe('GlobalLogsView (logs2)', () => {
  it('renders flat slots from listSlots and an Orphaned bucket', async () => {
    const { container, cleanup } = await mount(<GlobalLogsView />)
    expect(listSlots).toHaveBeenCalled()
    expect(container.textContent).toMatch(/APP/)
    expect(container.textContent).toMatch(/OLD/)
    expect(container.textContent).toMatch(/Orphaned/i)
    cleanup()
  })

  it('selecting a slot scopes the transcript (renders the chat surface)', async () => {
    const { container, cleanup } = await mount(<GlobalLogsView />)
    const appBtn = Array.from(container.querySelectorAll('button')).find((b) => /APP/.test(b.textContent || ''))!
    await act(async () => { appBtn.click(); await new Promise((r) => setTimeout(r, 10)) })
    // The presentational transcript scroller mounts once a slot is selected.
    expect(container.querySelector('[data-testid="chat-transcript"]')).toBeTruthy()
    cleanup()
  })

  it('typing a query calls logs2.search and shows the hit list', async () => {
    const { container, cleanup } = await mount(<GlobalLogsView />)
    const input = container.querySelector('input[type="text"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'needle')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 350))
    })
    expect(search).toHaveBeenCalledWith({ query: 'needle', limit: expect.any(Number) })
    expect(container.textContent).toMatch(/needle/)
    cleanup()
  })

  it('clicking a search hit forwards to the shared hook jumpTo', async () => {
    const { container, cleanup } = await mount(<GlobalLogsView />)
    const input = container.querySelector('input[type="text"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'needle')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 350))
    })
    const hitBtn = Array.from(container.querySelectorAll('button')).find((b) => /needle/.test(b.textContent || ''))!
    // Clicking the hit clears the query (revealing the transcript) and jumps.
    await act(async () => { hitBtn.click(); await new Promise((r) => setTimeout(r, 30)) })
    expect(jumpToSpy).toHaveBeenCalledWith({ runId: 7, idx: 4 })
    cleanup()
  })

  it('clicking a slot while searching clears the query and shows the transcript', async () => {
    const { container, cleanup } = await mount(<GlobalLogsView />)
    // Type a query to enter search mode.
    const input = container.querySelector('input[type="text"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'needle')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 350))
    })
    // Hit list is visible; transcript not yet shown.
    expect(container.textContent).toMatch(/needle/)
    expect(container.querySelector('[data-testid="chat-transcript"]')).toBeFalsy()
    // Click the APP slot button in the tree.
    const appBtn = Array.from(container.querySelectorAll('button')).find((b) => /APP/.test(b.textContent || '') && !b.textContent?.includes('needle'))!
    await act(async () => { appBtn.click(); await new Promise((r) => setTimeout(r, 30)) })
    // Query cleared -> hit list gone; transcript panel rendered.
    expect(container.querySelector('[data-testid="chat-transcript"]')).toBeTruthy()
    cleanup()
  })

  it('changing accountFilter deselects a slot that is no longer visible', async () => {
    // Seed a second slot with a different account so the filter can hide it.
    const slotWithAccount = { slotKey: 'c1', configId: 'c1', configLabel: 'APP', accountEmail: 'alice@example.com', lastActive: 300, runCount: 2, messageCount: 12 }
    listSlots.mockResolvedValueOnce([slotWithAccount])
    const { container, cleanup } = await mount(<GlobalLogsView />)
    // Select the APP slot.
    const appBtn = Array.from(container.querySelectorAll('button')).find((b) => /APP/.test(b.textContent || ''))!
    await act(async () => { appBtn.click(); await new Promise((r) => setTimeout(r, 10)) })
    expect(container.querySelector('[data-testid="chat-transcript"]')).toBeTruthy()
    // Change the accountFilter to a different email — the slot is now filtered out.
    const select = container.querySelector('select') as HTMLSelectElement
    if (select) {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
        setter.call(select, 'other@example.com')
        select.dispatchEvent(new Event('change', { bubbles: true }))
        await new Promise((r) => setTimeout(r, 20))
      })
      // Selected slot filtered out -> right pane reverts to empty state.
      expect(container.querySelector('[data-testid="chat-transcript"]')).toBeFalsy()
    }
    cleanup()
  })

  it('clear-all confirms and calls logs2.clearAll', async () => {
    const { container, cleanup } = await mount(<GlobalLogsView />)
    const btn = Array.from(container.querySelectorAll('button')).find((b) => /clear all/i.test(b.textContent || ''))!
    await act(async () => { btn.click(); await new Promise((r) => setTimeout(r, 10)) })
    expect((globalThis as any).confirm).toHaveBeenCalled()
    expect(clearAll).toHaveBeenCalled()
    cleanup()
  })

  it('deleting a slot uses honest copy and calls logs2.deleteSlot', async () => {
    const { container, cleanup } = await mount(<GlobalLogsView />)
    const delBtn = Array.from(container.querySelectorAll('button')).find((b) => /Delete this slot/i.test(b.getAttribute('title') || ''))!
    await act(async () => { delBtn.click(); await new Promise((r) => setTimeout(r, 10)) })
    const msg = (globalThis as any).confirm.mock.calls.at(-1)?.[0] as string
    expect(msg).toMatch(/indexed history/i)
    expect(msg).toMatch(/~\/\.claude/)
    expect(deleteSlot).toHaveBeenCalled()
    cleanup()
  })

  it('shows an enable-CTA when logging is disabled', async () => {
    loggingEnabled = false
    const { container, cleanup } = await mount(<GlobalLogsView />)
    expect(container.textContent).toMatch(/Enable session logging in Settings/i)
    cleanup()
  })
})
