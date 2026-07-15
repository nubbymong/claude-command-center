// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// Mock the windowing hook so the transcript view renders without real IPC reads.
vi.mock('../../../src/renderer/hooks/useWindowedTurns', () => ({
  useWindowedTurns: () => ({
    messages: [{ runId: 1, idx: 0, ts: 1, role: 'assistant', kind: 'message', content: 'hi', toolName: null, toolMeta: null }],
    pageCount: 1, follow: true, loading: false, loadingOlder: false, error: null,
    setFollow: vi.fn(), loadOlder: vi.fn().mockResolvedValue(undefined), jumpTo: vi.fn(), prependToken: 0,
  }),
}))

vi.mock('../../../src/renderer/stores/useLogsStore', () => ({
  useLogsStore: (sel: any) => sel({ togglePane: vi.fn() }),
}))

// Per-test controllable session + config + settings.
let session: any = { id: 's1', status: 'working', label: 'APP', provider: 'claude', configId: 'c1', workingDirectory: 'C:/work' }
let config: any = { id: 'c1', label: 'APP', provider: 'claude', workingDirectory: 'C:/work', claudeOptions: {} }
let globalLogging: boolean | undefined = true

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel({ sessions: session ? [session] : [] }),
}))
vi.mock('../../../src/renderer/stores/configStore', () => ({
  useConfigStore: (sel: any) => sel({ configs: config ? [config] : [] }),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => ({
  useSettingsStore: (sel: any) => sel({ settings: { loggingEnabled: globalLogging } }),
}))

let ingestStatus = vi.fn().mockResolvedValue({ transcripts: [{ path: 'p', status: 'tailing', ord: 0 }], messageCount: 5 })

beforeEach(() => {
  session = { id: 's1', status: 'working', label: 'APP', provider: 'claude', configId: 'c1', workingDirectory: 'C:/work' }
  config = { id: 'c1', label: 'APP', provider: 'claude', workingDirectory: 'C:/work', claudeOptions: {} }
  globalLogging = true
  ingestStatus = vi.fn().mockResolvedValue({ transcripts: [{ path: 'p', status: 'tailing', ord: 0 }], messageCount: 5 })
  ;(globalThis as any).ResizeObserver = class { observe() {} disconnect() {} unobserve() {} }
  // jsdom doesn't implement Element.scrollTo; the transcript view auto-sticks to
  // the bottom while following, so stub it.
  ;(HTMLElement.prototype as any).scrollTo = (HTMLElement.prototype as any).scrollTo ?? function () {}
  ;(globalThis as any).window.electronAPI = { logs2: { ingestStatus } }
})

import LogsPane from '../../../src/renderer/components/LogsPane'

const mount = async (el: React.ReactElement) => {
  const container = document.createElement('div')
  Object.defineProperty(container, 'getBoundingClientRect', { value: () => ({ width: 600, height: 400 }) })
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => { root.render(el) })
  await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  return { container, cleanup: () => { root.unmount(); container.remove() } }
}

const emptyReason = (c: HTMLElement) => (c.querySelector('[data-testid="log-empty-state"]') as HTMLElement | null)?.getAttribute('data-reason')

describe('LogsPane (logs2)', () => {
  it('renders the chat transcript when a transcript is detected', async () => {
    const { container, cleanup } = await mount(<LogsPane sessionId="s1" />)
    expect(ingestStatus).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(container.querySelector('[data-testid="chat-transcript"]')).toBeTruthy()
    expect(emptyReason(container)).toBeUndefined()
    cleanup()
  })

  it('shell-only session shows the shell empty state (no ingest probe)', async () => {
    session = { ...session, shellOnly: true }
    const { container, cleanup } = await mount(<LogsPane sessionId="s1" />)
    expect(emptyReason(container)).toBe('shell-only')
    expect(ingestStatus).not.toHaveBeenCalled()
    cleanup()
  })

  it('ssh session shows the remote empty state', async () => {
    session = { ...session, sessionType: 'ssh' }
    const { container, cleanup } = await mount(<LogsPane sessionId="s1" />)
    expect(emptyReason(container)).toBe('ssh')
    cleanup()
  })

  it('codex session shows the codex empty state', async () => {
    session = { ...session, provider: 'codex' }
    const { container, cleanup } = await mount(<LogsPane sessionId="s1" />)
    expect(emptyReason(container)).toBe('codex')
    cleanup()
  })

  it('global logging off shows the logging-off empty state', async () => {
    globalLogging = false
    const { container, cleanup } = await mount(<LogsPane sessionId="s1" />)
    expect(emptyReason(container)).toBe('logging-off')
    cleanup()
  })

  it('per-config logging off shows the logging-off empty state', async () => {
    config = { ...config, claudeOptions: { loggingEnabled: false } }
    const { container, cleanup } = await mount(<LogsPane sessionId="s1" />)
    expect(emptyReason(container)).toBe('logging-off')
    cleanup()
  })

  it('no transcript detected shows the no-transcript state with the watched cwd', async () => {
    ingestStatus = vi.fn().mockResolvedValue({ transcripts: [], messageCount: 0 })
    ;(globalThis as any).window.electronAPI = { logs2: { ingestStatus } }
    const { container, cleanup } = await mount(<LogsPane sessionId="s1" />)
    expect(emptyReason(container)).toBe('no-transcript')
    expect(container.textContent).toMatch(/C:\/work/)
    cleanup()
  })
})
