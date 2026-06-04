// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const sample = [
  { sessionId: 'a', configId: 'c1', configLabel: 'APP', projectCwd: null, accountEmail: null, profileId: null, provider: 'claude', startedAt: 200, endedAt: 300, status: 'exited', byteSize: 1024, eventCount: 3 },
  { sessionId: 'orph', configId: 'dead', configLabel: 'OLD', projectCwd: null, accountEmail: null, profileId: null, provider: 'claude', startedAt: 100, endedAt: 150, status: 'exited', byteSize: 512, eventCount: 1 },
  { sessionId: 'live', configId: 'c1', configLabel: 'APP', projectCwd: null, accountEmail: null, profileId: null, provider: 'claude', startedAt: 250, endedAt: null, status: 'running', byteSize: 100, eventCount: 1 },
]
const clearAll = vi.fn().mockResolvedValue({ deletedSessions: 2, deletedEvents: 4 })
const prune = vi.fn().mockResolvedValue({ deletedSessions: 1, deletedEvents: 1 })

let loggingEnabled = true

beforeEach(() => {
  loggingEnabled = true
  clearAll.mockClear(); prune.mockClear()
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
  ;(globalThis as any).confirm = vi.fn(() => true)
  ;(globalThis as any).alert = vi.fn()
  ;(globalThis as any).window.electronAPI = {
    logsdb: {
      listSessions: vi.fn().mockResolvedValue(sample),
      readEvents: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue([{ sessionId: 'a', eventId: 1, seq: 0, ts: 1, snippet: 'hit [needle]' }]),
      prune,
      clearAll,
    },
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

describe('GlobalLogsView', () => {
  it('renders config groups and the Orphaned bucket from listSessions', async () => {
    const { container, cleanup } = await mount(<GlobalLogsView />)
    expect(container.textContent).toMatch(/APP/)
    expect(container.textContent).toMatch(/Orphaned/i)
    cleanup()
  })

  it('clear-all confirms and calls logsdb.clearAll', async () => {
    const { container, cleanup } = await mount(<GlobalLogsView />)
    const btn = Array.from(container.querySelectorAll('button')).find((b) => /clear all/i.test(b.textContent || ''))!
    await act(async () => { btn.click() })
    expect((globalThis as any).confirm).toHaveBeenCalled()
    expect(clearAll).toHaveBeenCalled()
    cleanup()
  })

  it('typing a query switches the right pane to ranked search hits', async () => {
    const { container, cleanup } = await mount(<GlobalLogsView />)
    const search = container.querySelector('input[type="text"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'needle')
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 350))
    })
    expect((window as any).electronAPI.logsdb.search).toHaveBeenCalledWith('needle', expect.any(Number))
    expect(container.textContent).toMatch(/hit/)
    cleanup()
  })

  it('shows an enable-CTA when logging is disabled', async () => {
    loggingEnabled = false
    const { container, cleanup } = await mount(<GlobalLogsView />)
    expect(container.textContent).toMatch(/Enable session logging in Settings/i)
    cleanup()
  })

  it('clear-all broadcast excludes running sessions', async () => {
    const { container, cleanup } = await mount(<GlobalLogsView />)
    let broadcastIds: string[] | null = null
    const onDel = (e: Event) => { broadcastIds = (e as CustomEvent<{ sessionIds: string[] }>).detail.sessionIds }
    window.addEventListener('logs:sessionsDeleted', onDel as EventListener)
    const btn = Array.from(container.querySelectorAll('button')).find((b) => /clear all/i.test(b.textContent || ''))!
    await act(async () => { btn.click(); await new Promise((r) => setTimeout(r, 10)) })
    window.removeEventListener('logs:sessionsDeleted', onDel as EventListener)
    expect(broadcastIds).not.toBeNull()
    expect(broadcastIds).not.toContain('live')   // running session must NOT be broadcast as deleted
    expect(broadcastIds).toContain('a')          // a non-running session is broadcast
    cleanup()
  })

  it('clears search hits after a destructive delete (no orphaned rows)', async () => {
    const { container, cleanup } = await mount(<GlobalLogsView />)
    // type a query -> hits appear
    const search = container.querySelector('input[type="text"]') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(search, 'needle')
      search.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 350))
    })
    expect(container.textContent).toMatch(/hit/)
    // clear all while the query is still active
    const btn = Array.from(container.querySelectorAll('button')).find((b) => /clear all/i.test(b.textContent || ''))!
    await act(async () => { btn.click(); await new Promise((r) => setTimeout(r, 10)) })
    // hits cleared -> the search pane shows the empty state, not the stale 'hit' row
    expect(container.textContent).toMatch(/No matches/i)
    cleanup()
  })
})
