// @vitest-environment jsdom
/**
 * P3.15 (row 70): Alt+V with focus outside the terminal (with the terminal
 * focused, the key goes to the CLI, which pastes the image itself). The app
 * saves the clipboard image, then: a Claude session gets the line it always
 * got (unchanged); a Codex session gets its line through the Codex typing
 * rule (sendImagePathToCodex), whose notes show in the session's paste hint;
 * a plain terminal of either provider is treated as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const h = vi.hoisted(() => ({ sendImageToSession: vi.fn(), sendImagePathToCodex: vi.fn() }))
vi.mock('../../../src/renderer/onboarding/gate', () => ({ deriveOnboarding: () => ({ due: false, steps: [] }) }))
vi.mock('../../../src/renderer/utils/imageTransfer', () => ({ sendImageToSession: h.sendImageToSession }))
vi.mock('../../../src/renderer/lib/codexComposer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/lib/codexComposer')>()),
  sendImagePathToCodex: h.sendImagePathToCodex,
}))

const { useKeyboardShortcuts } = await import('../../../src/renderer/hooks/useKeyboardShortcuts')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useSettingsStore } = await import('../../../src/renderer/stores/settingsStore')
const { usePasteHintStore } = await import('../../../src/renderer/stores/pasteHintStore')
const { DEFAULT_SHORTCUTS } = await import('../../../src/renderer/utils/shortcuts')
import type { Session } from '../../../src/renderer/stores/sessionStore'

const IMG = 'C:\\res\\screenshots\\clipboard-1.jpg'
function session(id: string, extra: Partial<Session> = {}): Session {
  return { id, label: id, workingDirectory: '/x', model: 'opus', color: '#89b4fa', status: 'idle', createdAt: 0, sessionType: 'local', ...extra } as Session
}

function Host() {
  const activeSessionId = useSessionStore((s) => s.activeSessionId)
  useKeyboardShortcuts(activeSessionId, () => {}, () => {}, 'sessions', [], () => {})
  return null
}

let container: HTMLDivElement
let root: Root
let saveImage: ReturnType<typeof vi.fn>

beforeEach(() => {
  h.sendImageToSession.mockReset()
  h.sendImagePathToCodex.mockReset()
  saveImage = vi.fn(async () => ({ path: IMG }))
  ;(window as any).electronAPI = { clipboard: { saveImage } }
  useSettingsStore.setState({ settings: { keyboardShortcuts: DEFAULT_SHORTCUTS } as any })
  usePasteHintStore.setState({ hints: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

async function altV(sessions: Session[], active: string) {
  useSessionStore.setState({ sessions, activeSessionId: active, renamingSessionId: null })
  act(() => { root.render(<Host />) })
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', altKey: true, bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('Alt+V with focus outside the terminal (P3.15, row 70)', () => {
  it('a Claude session gets the line it always got, typed and submitted by the app', async () => {
    await altV([session('cl1')], 'cl1')
    expect(saveImage).toHaveBeenCalledTimes(1)
    expect(h.sendImageToSession).toHaveBeenCalledWith('cl1', IMG, 'I just pasted an image \u2014 please view it.', 'local')
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
  })

  it('a Codex session gets its line through the Codex typing rule, and that rule\'s note shows in the session\'s paste hint', async () => {
    await altV([session('cx1', { provider: 'codex' } as Partial<Session>)], 'cx1')
    expect(h.sendImageToSession).not.toHaveBeenCalled()
    expect(h.sendImagePathToCodex).toHaveBeenCalledTimes(1)
    const [sid, p, onNote] = h.sendImagePathToCodex.mock.calls[0]
    expect([sid, p]).toEqual(['cx1', IMG])
    act(() => { (onNote as (n: string) => void)('Codex is busy with a turn, so nothing was sent.') })
    expect(usePasteHintStore.getState().hints.cx1).toBe('Codex is busy with a turn, so nothing was sent.')
  })

  it('a plain terminal is treated as before, whichever provider its config names', async () => {
    await altV([session('sh1', { provider: 'codex', shellOnly: true } as Partial<Session>)], 'sh1')
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
    expect(h.sendImageToSession).toHaveBeenCalledWith('sh1', IMG, 'I just pasted an image \u2014 please view it.', 'local')
  })

  it('no image on the clipboard: the same hint as before, and nothing typed', async () => {
    saveImage.mockResolvedValue({ error: 'no-image' })
    await altV([session('cx1', { provider: 'codex' } as Partial<Session>)], 'cx1')
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
    expect(h.sendImageToSession).not.toHaveBeenCalled()
    expect(usePasteHintStore.getState().hints.cx1).toMatch(/No image in clipboard/)
  })
})
