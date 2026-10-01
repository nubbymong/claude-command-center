// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

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

describe('LogsPane chrome and the GitHub button (P3.16a, U1)', () => {
  // The GitHub button floats over the pane's top-right corner (GitHubPanel's
  // gh-fab: absolute top-2 right-2, an 18px icon in p-1.5 with a 1px border, so
  // 32px wide from 8px in) whenever the GitHub rail is collapsed or not set up.
  // The chrome's Close sits at the same corner, so the chrome keeps pr-12
  // (48px = 8 + 32 + 8) clear there, as the partner strip and the switch note
  // do. jsdom cannot hit-test, so both halves of the rule are pinned.
  it('keeps the floating GitHub button\'s corner clear, so Close is never under it', async () => {
    const { container, cleanup } = await mount(<LogsPane sessionId="s1" />)
    const chrome = container.querySelector('[data-testid="logs-pane-chrome"]') as HTMLElement
    expect(chrome, 'the pane chrome').toBeTruthy()
    const classes = chrome.className.split(/\s+/)
    expect(classes).toContain('pr-12')
    expect(classes.filter((c) => /^(px|pr)-/.test(c))).toEqual(['pr-12'])
    const close = [...chrome.querySelectorAll('button')].find((b) => b.textContent === 'Close')
    expect(close, 'the Close button is in the chrome').toBeTruthy()
    cleanup()
    const gh = readFileSync(resolve(__dirname, '../../../src/renderer/components/github/GitHubPanel.tsx'), 'utf8')
    const fabs = [...gh.matchAll(/<button\s+data-testid="gh-fab"([\s\S]*?)<\/button>/g)].map((m) => m[1])
    expect(fabs.length).toBeGreaterThan(0)
    for (const fab of fabs) {
      const fabClasses = (/className="(gh-fab [^"]*)"/.exec(fab)?.[1] ?? '').split(/\s+/)
      expect(fabClasses).toEqual(expect.arrayContaining(['absolute', 'top-2', 'right-2', 'p-1.5']))
      expect(fabClasses.filter((c) => /^(w|min-w|px|pl|pr)-/.test(c))).toEqual([])
      expect(fab.match(/<svg\b[\s\S]*?<\/svg>/g) ?? []).toHaveLength(1)
      expect(fab).toMatch(/<svg width="18" height="18"/)
    }
  })
})

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

  it('P3.12: a local Codex session shows its transcript, as a Claude one does', async () => {
    session = { ...session, provider: 'codex' }
    config = { ...config, provider: 'codex', claudeOptions: undefined, codexOptions: { permissionsPreset: 'read-only' } }
    const { container, cleanup } = await mount(<LogsPane sessionId="s1" />)
    expect(ingestStatus).toHaveBeenCalledWith({ sessionId: 's1' })
    expect(container.querySelector('[data-testid="chat-transcript"]')).toBeTruthy()
    expect(emptyReason(container)).toBeUndefined()
    cleanup()
  })

  it('P3.12: a Codex config\'s own logging opt-out shows the logging-off state (its Claude field is not read)', async () => {
    session = { ...session, provider: 'codex' }
    config = { ...config, provider: 'codex', claudeOptions: { loggingEnabled: true }, codexOptions: { permissionsPreset: 'read-only', loggingEnabled: false } }
    const { container, cleanup } = await mount(<LogsPane sessionId="s1" />)
    expect(emptyReason(container)).toBe('logging-off')
    cleanup()
    config = { ...config, provider: 'codex', claudeOptions: { loggingEnabled: false }, codexOptions: { permissionsPreset: 'read-only' } }
    const again = await mount(<LogsPane sessionId="s1" />)
    expect(emptyReason(again.container)).toBeUndefined()
    again.cleanup()
  })

  it('P3.12: a Codex session with no conversation yet says it is watching for Codex\'s transcript', async () => {
    session = { ...session, provider: 'codex' }
    config = { ...config, provider: 'codex', codexOptions: { permissionsPreset: 'read-only' } }
    ingestStatus = vi.fn().mockResolvedValue({ transcripts: [], messageCount: 0 })
    ;(globalThis as any).window.electronAPI = { logs2: { ingestStatus } }
    const { container, cleanup } = await mount(<LogsPane sessionId="s1" />)
    expect(emptyReason(container)).toBe('no-transcript')
    expect(container.textContent).toMatch(/Codex's transcript/)
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
