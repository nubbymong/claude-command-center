// @vitest-environment jsdom
/**
 * WP2 commit 6 (canvas F7): a Codex session's Restart menu in the session
 * header. "Restart and pick a conversation" marks the session for the resume
 * picker (the existing terminal script) and restarts it; plain "Restart"
 * restarts it without the picker. Claude sessions keep their Restart where it
 * was (the status strip) and get no menu here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
// The Ask header names the app version (a build-time define).
;(globalThis as any).__APP_VERSION__ = '0.0.0-test'

const killSessionPty = vi.fn()
vi.mock('../../../src/renderer/ptyTracker', () => ({
  killSessionPty: (...a: unknown[]) => killSessionPty(...a),
  clearSpawned: vi.fn(),
  hasSpawned: vi.fn(() => false),
  markSpawned: vi.fn(),
}))
const markSessionForResumePicker = vi.fn()
vi.mock('../../../src/renderer/utils/resumePicker', () => ({
  markSessionForResumePicker: (...a: unknown[]) => markSessionForResumePicker(...a),
  shouldUseResumePicker: vi.fn(() => false),
}))
vi.mock('../../../src/renderer/hooks/useThemeController', () => ({ useResolvedTheme: () => 'dark' }))
vi.mock('../../../src/renderer/hooks/useTypography', () => ({ useRegionTypography: () => ({}) }))

const { default: SessionHeader } = await import('../../../src/renderer/components/SessionHeader')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
import type { Session } from '../../../src/renderer/stores/sessionStore'

function makeSession(over: Partial<Session> = {}): Session {
  return {
    id: 's1', label: 'api-server', workingDirectory: 'C:/proj', model: '', color: '#ff0000', status: 'idle',
    createdAt: 1, sessionType: 'local', provider: 'codex', codexOptions: { permissionsPreset: 'standard' }, ...over,
  } as Session
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  killSessionPty.mockReset()
  markSessionForResumePicker.mockReset()
  ;(globalThis as any).window.electronAPI = {
    accountWeb: { status: vi.fn(async () => ({ ok: true, cli: { authenticated: false }, web: { status: 'none' } })) },
    pty: { kill: vi.fn() },
  }
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function renderWith(s: Session) {
  useSessionStore.setState({ sessions: [s], activeSessionId: s.id, isRestoring: false })
  act(() => { root.render(<SessionHeader session={s} />) })
}
const openMenu = () => act(() => { (container.querySelector('[data-testid="codex-restart"]') as HTMLButtonElement).click() })
const item = (key: string) => document.body.querySelector(`[data-testid="codex-restart-${key}"]`) as HTMLButtonElement | null

describe('Codex Restart menu', () => {
  it('offers "Restart" and "Restart and pick a conversation"', () => {
    renderWith(makeSession())
    openMenu()
    expect(item('fresh')!.textContent).toBe('Restart')
    expect(item('pick')!.textContent).toBe('Restart and pick a conversation')
  })

  it('"Restart and pick a conversation" marks the resume picker, then restarts', () => {
    renderWith(makeSession())
    openMenu()
    act(() => { item('pick')!.click() })
    expect(markSessionForResumePicker).toHaveBeenCalledWith('s1')
    expect(killSessionPty).toHaveBeenCalledWith('s1')
    // Restarted: re-added with a fresh createdAt, so its terminal remounts.
    expect(useSessionStore.getState().getSession('s1')!.createdAt).toBeGreaterThan(1)
  })

  it('"Restart" restarts without the picker (a new conversation)', () => {
    renderWith(makeSession())
    openMenu()
    act(() => { item('fresh')!.click() })
    expect(killSessionPty).toHaveBeenCalledWith('s1')
    expect(markSessionForResumePicker).not.toHaveBeenCalled()
  })

  it('a Claude session gets no Codex menu in the header', () => {
    renderWith(makeSession({ provider: 'claude', codexOptions: undefined }))
    expect(container.querySelector('[data-testid="codex-restart"]')).toBeNull()
  })

  it('an Ask Conductor session and a shell-only Codex session get no Codex menu either', () => {
    renderWith(makeSession({ kind: 'ask' }))
    expect(container.querySelector('[data-testid="codex-restart"]')).toBeNull()
    renderWith(makeSession({ shellOnly: true }))
    expect(container.querySelector('[data-testid="codex-restart"]')).toBeNull()
  })
})

describe("the Codex mark before a Codex session's name (canvas F7)", () => {
  it("draws the app's own Codex mark, before the name", () => {
    renderWith(makeSession())
    const mark = container.querySelector('[data-testid="provider-mark-codex"]')!
    expect(mark).not.toBeNull()
    expect(mark.getAttribute('title')).toBe('Codex')
    const name = Array.from(container.querySelectorAll('*')).find((el) => el.children.length === 0 && el.textContent === 'api-server')!
    // The mark comes first in document order.
    expect(mark.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('no mark for a Claude or a shell-only session', () => {
    renderWith(makeSession({ provider: 'claude', codexOptions: undefined }))
    expect(container.querySelector('[data-testid="provider-mark-codex"]')).toBeNull()
    renderWith(makeSession({ shellOnly: true }))
    expect(container.querySelector('[data-testid="provider-mark-codex"]')).toBeNull()
  })
})
