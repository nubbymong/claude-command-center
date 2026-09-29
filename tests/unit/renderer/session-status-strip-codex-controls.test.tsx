// @vitest-environment jsdom
/**
 * P3.8 (row 61): a Codex tab's status strip carries the controls a Claude tab's
 * does, Compact among them, and Compact runs Codex's own /compact (P3.1: the
 * command exists on 0.153.4 and 0.155.1).
 *
 * Codex's composer takes a burst of typed characters ending in Enter as a paste
 * (the CLI's paste-burst handling, `disable_paste_burst` in its config), so the
 * Enter would become a newline rather than submit. The command is therefore
 * typed first and Enter follows on its own once the burst is over, and only
 * into the same run of the session: a Restart (or the tab going) in between
 * cancels it, so a delayed Enter can never answer the next run's first prompt.
 * Claude's Compact is unchanged (one write, `/compact\n`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const sessionState: any = { sessions: [] }
const settingsState: any = { settings: {} }
const restartState = vi.hoisted(() => ({ restart: vi.fn() }))

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: (sel: any) => sel(sessionState),
}))
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore, DEFAULT_STATUS_LINE: { font: 'sans', fontSize: 11 } }
})
vi.mock('../../../src/renderer/stores/accountProfilesStore', () => ({
  useAccountProfilesStore: (sel: any) => sel({ profiles: [] }),
}))
vi.mock('../../../src/renderer/hooks/useCodexReviewUsage', () => ({ useCodexReviewUsage: () => null }))
vi.mock('../../../src/renderer/hooks/useRestartSession', () => ({ useRestartSession: () => ({ restart: restartState.restart }) }))
vi.mock('../../../src/renderer/hooks/useSwitchAccount', () => ({ useSwitchAccount: () => () => {} }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))

const { default: SessionStatusStrip, CODEX_SUBMIT_DELAY_MS } = await import('../../../src/renderer/components/SessionStatusStrip')

let container: HTMLDivElement
let root: Root
let write: ReturnType<typeof vi.fn>

const codex = (over: Record<string, unknown> = {}) => ({ id: 's1', provider: 'codex', createdAt: 1000, contextPercent: 10, ...over })
const render = () => act(() => { root.render(createElement(SessionStatusStrip, { sessionId: 's1' })) })
const button = (title: string) => container.querySelector(`[title="${title}"]`) as HTMLButtonElement | null
const writes = () => write.mock.calls.map((c) => [c[0], c[1]])

beforeEach(() => {
  vi.useFakeTimers()
  write = vi.fn()
  ;(globalThis as any).window.electronAPI = { pty: { write } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  sessionState.sessions = [codex()]
  settingsState.settings = { statusLine: { font: 'sans', fontSize: 11 }, theme: 'dark', accountAliases: {}, accountColourOverrides: {} }
  restartState.restart.mockClear()
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
})

describe('a Codex tab has the strip controls (row 61)', () => {
  it('shows Compact and Restart', () => {
    render()
    expect(button('Compact the conversation')).not.toBeNull()
    expect(button('Restart session')).not.toBeNull()
  })

  it('keeps them with the status line switched off, as a Claude tab does', () => {
    settingsState.settings.statusLineEnabled = false
    render()
    expect(container.textContent).not.toContain('10%')
    expect(button('Compact the conversation')).not.toBeNull()
    expect(button('Restart session')).not.toBeNull()
  })

  it('Restart restarts the session', () => {
    render()
    act(() => { button('Restart session')!.click() })
    expect(restartState.restart).toHaveBeenCalledTimes(1)
  })
})

describe("Compact on a Codex tab runs Codex's own /compact", () => {
  it('types /compact, then Enter on its own once the burst is over, and nothing else', () => {
    render()
    act(() => { button('Compact the conversation')!.click() })
    expect(writes()).toEqual([['s1', '/compact']])
    act(() => { vi.advanceTimersByTime(CODEX_SUBMIT_DELAY_MS - 1) })
    expect(writes()).toEqual([['s1', '/compact']])
    act(() => { vi.advanceTimersByTime(1) })
    expect(writes()).toEqual([['s1', '/compact'], ['s1', '\r']])
    act(() => { vi.advanceTimersByTime(CODEX_SUBMIT_DELAY_MS * 10) })
    expect(writes()).toHaveLength(2)
  })

  it('waits long enough for the burst to be over', () => {
    expect(CODEX_SUBMIT_DELAY_MS).toBeGreaterThanOrEqual(200)
    expect(CODEX_SUBMIT_DELAY_MS).toBeLessThanOrEqual(1000)
  })

  it('a second press while one is pending types nothing more', () => {
    render()
    act(() => { button('Compact the conversation')!.click() })
    act(() => { button('Compact the conversation')!.click() })
    act(() => { vi.advanceTimersByTime(CODEX_SUBMIT_DELAY_MS) })
    expect(writes()).toEqual([['s1', '/compact'], ['s1', '\r']])
  })

  it('a Restart before the Enter cancels it: the next run never receives it', () => {
    render()
    act(() => { button('Compact the conversation')!.click() })
    sessionState.sessions = [codex({ createdAt: 2000 })]
    render()
    act(() => { vi.advanceTimersByTime(CODEX_SUBMIT_DELAY_MS) })
    expect(writes()).toEqual([['s1', '/compact']])
  })

  it('a run that has ended before the Enter does not receive it', () => {
    render()
    act(() => { button('Compact the conversation')!.click() })
    sessionState.sessions = [codex({ ptyExited: true })]
    render()
    act(() => { vi.advanceTimersByTime(CODEX_SUBMIT_DELAY_MS) })
    expect(writes()).toEqual([['s1', '/compact']])
  })

  it('the strip going away before the Enter cancels it', () => {
    render()
    act(() => { button('Compact the conversation')!.click() })
    act(() => { root.unmount() })
    root = createRoot(container)
    act(() => { vi.advanceTimersByTime(CODEX_SUBMIT_DELAY_MS) })
    expect(writes()).toEqual([['s1', '/compact']])
  })
})

describe("Claude's Compact is unchanged", () => {
  it('one write, /compact and a newline', () => {
    sessionState.sessions = [{ id: 's1', provider: 'claude', createdAt: 1000, contextPercent: 10 }]
    render()
    act(() => { button('Compact the conversation')!.click() })
    act(() => { vi.advanceTimersByTime(CODEX_SUBMIT_DELAY_MS * 2) })
    expect(writes()).toEqual([['s1', '/compact\n']])
  })
})
