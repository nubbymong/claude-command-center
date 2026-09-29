// @vitest-environment jsdom
/**
 * P3.8 (row 61): a Codex tab's status strip carries the controls a Claude tab's
 * does, Compact among them, and Compact runs Codex's own /compact (P3.1: the
 * command exists on 0.153.4 and 0.155.1).
 *
 * Round 1 (C1, C2, C3): Compact types /compact only into Codex's ready, empty
 * composer (the terminal's live screen, lib/codexComposer.ts), and presses
 * Enter 300 ms later only in the same run and only when the composer holds
 * exactly /compact; otherwise it types nothing and the strip says why for a
 * moment. App renders ONE strip, re-pointed at whichever tab is shown: a
 * press's Enter belongs to the session it was pressed on, and is dropped when
 * the strip is re-pointed or goes away. Claude's Compact is unchanged (one
 * write, `/compact\n`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import * as S from './codex-composer-screens'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const sessionState: any = { sessions: [] }
const settingsState: any = { settings: {} }
const restartState = vi.hoisted(() => ({ restart: vi.fn() }))

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: Object.assign((sel: any) => sel(sessionState), { getState: () => sessionState }),
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

const { default: SessionStatusStrip, CODEX_NOTE_MS } = await import('../../../src/renderer/components/SessionStatusStrip')
const { CODEX_SUBMIT_DELAY_MS } = await import('../../../src/renderer/lib/codexComposer')
const { registerScreenReader } = await import('../../../src/renderer/components/terminal/screenRegistry')
const { markSpawned, clearSpawned } = await import('../../../src/renderer/ptyTracker')

let container: HTMLDivElement
let root: Root
let write: ReturnType<typeof vi.fn>
/** Each session's live screen, as its terminal would report it. */
const screens = new Map<string, typeof S.READY>()
const unregister: Array<() => void> = []

const codex = (over: Record<string, unknown> = {}) => ({ id: 's1', provider: 'codex', createdAt: 1000, contextPercent: 10, ...over })
const render = (id = 's1') => act(() => { root.render(createElement(SessionStatusStrip, { sessionId: id })) })
const button = (title: string) => container.querySelector(`[title="${title}"]`) as HTMLButtonElement | null
const note = () => container.querySelector('[data-testid="codex-command-note"]')?.textContent ?? null
const writes = () => write.mock.calls.map((c) => [c[0], c[1]])
/** A live terminal for `id`: its screen, and a spawn token for its PTY. */
const live = (id: string, screen: typeof S.READY) => {
  screens.set(id, screen)
  unregister.push(registerScreenReader(id, () => screens.get(id) ?? null))
  markSpawned(id)
}

beforeEach(() => {
  vi.useFakeTimers()
  // What typing does to the composer: the command shows in it, with its popup.
  write = vi.fn((id: string, data: string) => {
    if (data === '/compact') screens.set(id, S.TYPED_COMPACT)
  })
  ;(globalThis as any).window.electronAPI = { pty: { write } }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  sessionState.sessions = [codex()]
  settingsState.settings = { statusLine: { font: 'sans', fontSize: 11 }, theme: 'dark', accountAliases: {}, accountColourOverrides: {} }
  restartState.restart.mockClear()
  screens.clear()
  live('s1', S.READY)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  for (const off of unregister.splice(0)) off()
  clearSpawned('s1')
  clearSpawned('s2')
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

describe("Compact on a Codex tab runs Codex's own /compact, only at its ready prompt", () => {
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
    expect(note()).toBeNull()
  })

  it('types nothing at the trust prompt, in a picker or mid-turn, and says why for a moment (C1)', () => {
    for (const [screen, said] of [[S.TRUST, /not at its prompt/], [S.MODEL_PICKER, /not at its prompt/], [S.WORKING_NOW, /busy/], [S.USER_TYPING, /already typed/]] as const) {
      screens.set('s1', screen)
      render()
      act(() => { button('Compact the conversation')!.click() })
      act(() => { vi.advanceTimersByTime(CODEX_SUBMIT_DELAY_MS * 3) })
      expect(writes()).toEqual([])
      expect(note()).toMatch(said)
      act(() => { vi.advanceTimersByTime(CODEX_NOTE_MS) })
      expect(note()).toBeNull()
    }
  })

  it('a second press while one is pending types nothing more', () => {
    render()
    act(() => { button('Compact the conversation')!.click() })
    act(() => { button('Compact the conversation')!.click() })
    act(() => { vi.advanceTimersByTime(CODEX_SUBMIT_DELAY_MS) })
    expect(writes()).toEqual([['s1', '/compact'], ['s1', '\r']])
  })

  it('text the user types in the window keeps its Enter: /compact is left typed, never sent with it (C3)', () => {
    render()
    act(() => { button('Compact the conversation')!.click() })
    screens.set('s1', S.TYPED_AFTER_USER)
    act(() => { vi.advanceTimersByTime(CODEX_SUBMIT_DELAY_MS) })
    expect(writes()).toEqual([['s1', '/compact']])
  })

  it('a Restart, the run ending, or a new PTY before the Enter cancels it: the next run never receives it (C2)', () => {
    for (const change of [
      () => { sessionState.sessions = [codex({ createdAt: 2000 })] },
      () => { sessionState.sessions = [codex({ ptyExited: true })] },
      () => { markSpawned('s1') },
    ]) {
      write.mockClear()
      screens.set('s1', S.READY)
      sessionState.sessions = [codex()]
      render()
      act(() => { button('Compact the conversation')!.click() })
      change()
      render()
      act(() => { vi.advanceTimersByTime(CODEX_SUBMIT_DELAY_MS) })
      expect(writes()).toEqual([['s1', '/compact']])
    }
  })

  it('the one strip re-pointed at another tab drops the press\'s Enter, for tabs that share a start time too (C2)', () => {
    live('s2', S.READY)
    sessionState.sessions = [codex(), codex({ id: 's2' })]
    render('s1')
    act(() => { button('Compact the conversation')!.click() })
    render('s2')
    act(() => { vi.advanceTimersByTime(CODEX_SUBMIT_DELAY_MS * 3) })
    expect(writes()).toEqual([['s1', '/compact']])
    // And Compact on the tab now shown works on its own.
    act(() => { button('Compact the conversation')!.click() })
    act(() => { vi.advanceTimersByTime(CODEX_SUBMIT_DELAY_MS) })
    expect(writes()).toEqual([['s1', '/compact'], ['s2', '/compact'], ['s2', '\r']])
  })

  it('the tab closing (the strip going away) before the Enter cancels it', () => {
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
