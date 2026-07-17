// @vitest-environment jsdom
/**
 * TabBar inline session rename (#119-adjacent feature): double-click / store
 * beginRename() enters edit mode; committing writes customName (NOT label), and
 * blank reverts. Proves the edit mode actually renders — independent of the
 * running app (where a Zustand fast-refresh desync masked it during dev).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// TabBar pulls killSessionPty from ./TerminalView, which imports xterm — mock it
// so the test doesn't load the GPU/terminal stack.
vi.mock('../../../src/renderer/components/TerminalView', () => ({ killSessionPty: vi.fn() }))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/hooks/useTypography', () => ({ useRegionTypography: () => ({}) }))

const { default: TabBar } = await import('../../../src/renderer/components/TabBar')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
import type { Session } from '../../../src/renderer/stores/sessionStore'

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', label: 'API Refactor', workingDirectory: '/x', model: 'opus',
    color: '#89b4fa', status: 'idle', createdAt: 0, sessionType: 'local', ...over,
  } as Session
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  useSessionStore.setState({ sessions: [makeSession()], activeSessionId: 's1', renamingSessionId: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const render = () => act(() => { root.render(<TabBar />) })
const tabButton = () =>
  Array.from(container.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === 'API Refactor')

describe('TabBar rename', () => {
  it('shows customName over label when set', () => {
    useSessionStore.setState({ sessions: [makeSession({ customName: 'Boot perf' })], activeSessionId: 's1' })
    render()
    expect(container.textContent).toContain('Boot perf')
  })

  it('double-click enters inline edit mode (renders an input)', () => {
    render()
    expect(container.querySelector('input')).toBeNull()
    act(() => { tabButton()!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) })
    expect(useSessionStore.getState().renamingSessionId).toBe('s1')
    expect(container.querySelector('input')).not.toBeNull()
  })

  it('beginRename() from the store renders the editor', () => {
    render()
    act(() => { useSessionStore.getState().beginRename('s1') })
    expect(container.querySelector('input')).not.toBeNull()
  })

  it('committing with Enter writes customName (not label) and exits edit mode', () => {
    render()
    act(() => { useSessionStore.getState().beginRename('s1') })
    const input = container.querySelector('input') as HTMLInputElement
    input.value = 'IM-8315 keychain'
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    const s = useSessionStore.getState().sessions[0]
    expect(s.customName).toBe('IM-8315 keychain')
    expect(s.label).toBe('API Refactor') // origin untouched
    expect(useSessionStore.getState().renamingSessionId).toBeNull()
  })

  it('blank commit clears customName (reverts to label)', () => {
    useSessionStore.setState({ sessions: [makeSession({ customName: 'old' })], activeSessionId: 's1' })
    render()
    act(() => { useSessionStore.getState().beginRename('s1') })
    const input = container.querySelector('input') as HTMLInputElement
    input.value = '   '
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    expect(useSessionStore.getState().sessions[0].customName).toBeUndefined()
  })
})
