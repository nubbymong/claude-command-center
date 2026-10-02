// @vitest-environment jsdom
/**
 * P3.15 (row 70): Alt+V with focus outside the terminal (with the terminal
 * focused, the key goes to the CLI, which pastes the image itself). The app
 * saves the clipboard image, then: a Claude session gets the line it always
 * got (unchanged); a Codex session gets its line through the Codex typing
 * rule (sendImagePathToCodex), whose notes show in the session's paste hint;
 * a plain terminal (P3.16a, U6) gets only the image's path, quoted for its shell,
 * typed and not submitted, with no sentence: a shell reads no images, and a
 * sentence and an Enter would be typed into it as a command. Over SSH the file
 * is on this computer, which the remote shell cannot read, so nothing is typed
 * and the hint says so.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// typeImagePathIntoShell says whether it typed (PR-level ADR-009 round 1, A1): it does, unless a case says not.
const h = vi.hoisted(() => ({ sendImageToSession: vi.fn(), sendImagePathToCodex: vi.fn(), typeImagePathIntoShell: vi.fn((..._a: unknown[]) => true) }))
vi.mock('../../../src/renderer/onboarding/gate', () => ({ deriveOnboarding: () => ({ due: false, steps: [] }) }))
vi.mock('../../../src/renderer/utils/imageTransfer', () => ({ sendImageToSession: h.sendImageToSession, typeImagePathIntoShell: h.typeImagePathIntoShell }))
vi.mock('../../../src/renderer/lib/codexComposer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/lib/codexComposer')>()),
  sendImagePathToCodex: h.sendImagePathToCodex,
}))

const { useKeyboardShortcuts } = await import('../../../src/renderer/hooks/useKeyboardShortcuts')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { useSettingsStore } = await import('../../../src/renderer/stores/settingsStore')
const { usePasteHintStore } = await import('../../../src/renderer/stores/pasteHintStore')
const { DEFAULT_SHORTCUTS } = await import('../../../src/renderer/utils/shortcuts')
const { markSpawned, clearSpawned } = await import('../../../src/renderer/ptyTracker')
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
  h.typeImagePathIntoShell.mockReset()
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
  // Set by the platform loops; deleted here so a failing case cannot leave it
  // for the cases after it (P3.16a UI round 1).
  delete (window as any).electronPlatform
})

async function altV(sessions: Session[], active: string) {
  useSessionStore.setState({ sessions, activeSessionId: active, renamingSessionId: null })
  act(() => { root.render(<Host />) })
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', altKey: true, bubbles: true })) })
  // The handler awaits the saved image, then acts once: a sender, or a hint.
  await vi.waitFor(() => {
    const acted = h.sendImageToSession.mock.calls.length + h.sendImagePathToCodex.mock.calls.length + h.typeImagePathIntoShell.mock.calls.length + Object.keys(usePasteHintStore.getState().hints).length
    if (acted === 0) throw new Error('the Alt+V handler has not acted yet')
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

  it('a plain terminal on this computer gets only the path, whichever provider its config names: no sentence typed for an assistant, nothing submitted', async () => {
    for (const provider of ['claude', 'codex'] as const) {
      h.typeImagePathIntoShell.mockReset()
      await altV([session('sh1', { provider, shellOnly: true } as Partial<Session>)], 'sh1')
      expect(h.typeImagePathIntoShell, provider).toHaveBeenCalledTimes(1)
      expect(h.typeImagePathIntoShell.mock.calls[0].slice(0, 2), provider).toEqual(['sh1', IMG])
      expect(h.sendImageToSession, provider).not.toHaveBeenCalled()
      expect(h.sendImagePathToCodex, provider).not.toHaveBeenCalled()
      expect(usePasteHintStore.getState().hints.sh1, provider).toBeUndefined()
    }
  })

  it('the path is quoted for the shell the plain terminal runs: PowerShell on Windows, a POSIX shell elsewhere', async () => {
    for (const [platform, isWin32] of [['win32', true], ['linux', false], ['darwin', false]] as const) {
      ;(window as any).electronPlatform = platform
      h.typeImagePathIntoShell.mockReset()
      await altV([session('sh1', { shellOnly: true } as Partial<Session>)], 'sh1')
      expect(h.typeImagePathIntoShell.mock.calls[0][2], platform).toBe(isWin32)
    }
  })

  // P3.16a UI round 1: a plain terminal whose process has ended, or that never
  // started, has no shell to type into; it says so, as the other refusals do.
  it('a plain terminal that is not running gets nothing typed, and the hint says so and where the image is', async () => {
    for (const dead of [{ ptyExited: true }, { neverStarted: true }, { ptyExited: true, sessionType: 'ssh' as const }]) {
      const label = JSON.stringify(dead)
      h.typeImagePathIntoShell.mockReset()
      usePasteHintStore.setState({ hints: {} })
      await altV([session('sh3', { shellOnly: true, ...dead } as Partial<Session>)], 'sh3')
      expect(h.typeImagePathIntoShell, label).not.toHaveBeenCalled()
      expect(h.sendImageToSession, label).not.toHaveBeenCalled()
      expect(h.sendImagePathToCodex, label).not.toHaveBeenCalled()
      const hint = usePasteHintStore.getState().hints.sh3
      expect(hint, label).toContain('not running')
      expect(hint, label).toContain(IMG)
    }
  })

  it('a plain terminal over SSH gets nothing typed (the file is on this computer, which the remote shell cannot read), and the hint says so', async () => {
    await altV([session('sh2', { shellOnly: true, sessionType: 'ssh' } as Partial<Session>)], 'sh2')
    expect(h.typeImagePathIntoShell).not.toHaveBeenCalled()
    expect(h.sendImageToSession).not.toHaveBeenCalled()
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
    const hint = usePasteHintStore.getState().hints.sh2
    expect(hint).toContain('remote shell cannot read')
    expect(hint).toContain(IMG)
  })

  // PR-level ADR-009 round 1 (A1): main says, with the saved image, whether the
  // shell it spawns a plain terminal with is of the sh family; that word goes to
  // the typing rule, and a path the rule does not type shows where it was saved.
  it('macOS and Linux: main\'s word on the shell goes to the typing rule; a path it does not type shows where the image was saved', async () => {
    for (const posixShell of ['sh', 'other'] as const) {
      ;(window as any).electronPlatform = 'linux'
      saveImage.mockResolvedValue({ path: '/res/screenshots/clipboard-1.jpg', posixShell })
      h.typeImagePathIntoShell.mockReset()
      if (posixShell === 'other') h.typeImagePathIntoShell.mockReturnValueOnce(false)
      usePasteHintStore.setState({ hints: {} })
      await altV([session('sh4', { shellOnly: true } as Partial<Session>)], 'sh4')
      expect(h.typeImagePathIntoShell.mock.calls[0], posixShell).toEqual(['sh4', '/res/screenshots/clipboard-1.jpg', false, posixShell])
      const hint = usePasteHintStore.getState().hints.sh4
      if (posixShell === 'sh') expect(hint, posixShell).toBeUndefined()
      else expect(hint, posixShell).toBe('The image was saved on this computer at /res/screenshots/clipboard-1.jpg; nothing was typed into this terminal.')
    }
  })

  it('Windows: unchanged, the path typed for PowerShell whatever main says of a POSIX shell', async () => {
    ;(window as any).electronPlatform = 'win32'
    saveImage.mockResolvedValue({ path: IMG })
    await altV([session('sh5', { shellOnly: true } as Partial<Session>)], 'sh5')
    expect(h.typeImagePathIntoShell.mock.calls[0].slice(0, 3)).toEqual(['sh5', IMG, true])
    expect(usePasteHintStore.getState().hints.sh5).toBeUndefined()
  })

  it('no image on the clipboard: the same hint as before, and nothing typed', async () => {
    saveImage.mockResolvedValue({ error: 'no-image' })
    await altV([session('cx1', { provider: 'codex' } as Partial<Session>)], 'cx1')
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
    expect(h.sendImageToSession).not.toHaveBeenCalled()
    expect(usePasteHintStore.getState().hints.cx1).toMatch(/No image in clipboard/)
  })
})

/**
 * P3.16a (N9): the partner view shows the tab's partner shell (a plain shell on
 * this computer, PTY id `<session id>-partner`) in place of the session's own
 * terminal, which is hidden then. Alt+V goes to the pane on screen: in the
 * partner view that is the partner shell, which gets what a plain terminal
 * gets (the quoted path, no sentence, no Enter), and the hidden assistant gets
 * nothing. In the main view the assistant routes above apply.
 * The panes are the elements TerminalView renders: data-terminal-session names
 * the PTY id, and data-terminal-active marks the one pane on screen.
 */
describe('Alt+V in the partner view goes to the partner shell on screen (P3.16a, N9)', () => {
  let paneEls: HTMLElement[] = []
  // A mounted partner pane's shell is running (its spawn is the tab's current
  // one, ptyTracker), unless a case says it is not (round 2, Q7).
  function mountPanes(panes: Array<[string, boolean]>, opts: { partnerRunning?: boolean } = {}) {
    for (const [id, onScreen] of panes) {
      const el = document.createElement('div')
      el.setAttribute('data-terminal-session', id)
      if (onScreen) el.setAttribute('data-terminal-active', '')
      document.body.appendChild(el)
      paneEls.push(el)
      if (id.endsWith('-partner') && opts.partnerRunning !== false) markSpawned(id)
    }
  }
  afterEach(() => {
    for (const el of paneEls) { clearSpawned(el.getAttribute('data-terminal-session') ?? ''); el.remove() }
    paneEls = []
    delete (window as any).electronPlatform
  })

  // P3.16a round 2 (Q7): a partner shell that is not running (its process
  // ended, or a Restart's next one has not started) has no shell to type into.
  it('a partner shell that is not running: nothing is typed into either terminal, and the hint says so and where the image is', async () => {
    for (const extra of [{}, { provider: 'codex' }, { shellOnly: true }, { sessionType: 'ssh' }] as Array<Partial<Session>>) {
      const label = JSON.stringify(extra)
      h.typeImagePathIntoShell.mockReset(); h.sendImageToSession.mockReset(); h.sendImagePathToCodex.mockReset()
      usePasteHintStore.setState({ hints: {} })
      for (const el of paneEls) { clearSpawned(el.getAttribute('data-terminal-session') ?? ''); el.remove() }
      paneEls = []
      mountPanes([['px1', false], ['px1-partner', true]], { partnerRunning: false })
      await altV([session('px1', extra)], 'px1')
      expect(h.typeImagePathIntoShell, label).not.toHaveBeenCalled()
      expect(h.sendImageToSession, label).not.toHaveBeenCalled()
      expect(h.sendImagePathToCodex, label).not.toHaveBeenCalled()
      expect(usePasteHintStore.getState().hints.px1, label).toBe(`This terminal is not running, so nothing was typed; the image was saved on this computer at ${IMG}.`)
    }
  })

  it('a partner shell whose process ended (its spawn cleared) is not running either; once it is spawned again, the path is typed into it', async () => {
    mountPanes([['px2', false], ['px2-partner', true]])
    clearSpawned('px2-partner')
    await altV([session('px2')], 'px2')
    expect(h.typeImagePathIntoShell).not.toHaveBeenCalled()
    expect(usePasteHintStore.getState().hints.px2).toMatch(/not running/)
    usePasteHintStore.setState({ hints: {} })
    markSpawned('px2-partner')
    await altV([session('px2')], 'px2')
    expect(h.typeImagePathIntoShell.mock.calls[0].slice(0, 2)).toEqual(['px2-partner', IMG])
  })

  it('a Codex tab showing its partner shell: only the quoted path, typed into the partner PTY, and nothing to the hidden Codex session', async () => {
    mountPanes([['cx1', false], ['cx1-partner', true]])
    await altV([session('cx1', { provider: 'codex' } as Partial<Session>)], 'cx1')
    expect(h.typeImagePathIntoShell).toHaveBeenCalledTimes(1)
    expect(h.typeImagePathIntoShell.mock.calls[0].slice(0, 2)).toEqual(['cx1-partner', IMG])
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
    expect(h.sendImageToSession).not.toHaveBeenCalled()
    expect(usePasteHintStore.getState().hints).toEqual({})
  })

  it('a Codex tab showing its main view (the partner mounted and hidden): the Codex route, to the Codex session', async () => {
    mountPanes([['cx1', true], ['cx1-partner', false]])
    await altV([session('cx1', { provider: 'codex' } as Partial<Session>)], 'cx1')
    expect(h.sendImagePathToCodex).toHaveBeenCalledTimes(1)
    expect(h.sendImagePathToCodex.mock.calls[0].slice(0, 2)).toEqual(['cx1', IMG])
    expect(h.typeImagePathIntoShell).not.toHaveBeenCalled()
    expect(h.sendImageToSession).not.toHaveBeenCalled()
  })

  it('a Claude tab showing its partner shell: only the quoted path, typed into the partner PTY, and no line for the hidden Claude session', async () => {
    mountPanes([['cl1', false], ['cl1-partner', true]])
    await altV([session('cl1')], 'cl1')
    expect(h.typeImagePathIntoShell).toHaveBeenCalledTimes(1)
    expect(h.typeImagePathIntoShell.mock.calls[0].slice(0, 2)).toEqual(['cl1-partner', IMG])
    expect(h.sendImageToSession).not.toHaveBeenCalled()
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
  })

  it('a Claude tab showing its main view (the partner mounted and hidden): the line it always got, to the Claude session', async () => {
    mountPanes([['cl1', true], ['cl1-partner', false]])
    await altV([session('cl1')], 'cl1')
    expect(h.sendImageToSession).toHaveBeenCalledWith('cl1', IMG, 'I just pasted an image \u2014 please view it.', 'local')
    expect(h.typeImagePathIntoShell).not.toHaveBeenCalled()
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
  })

  it('an SSH tab showing its partner shell: the partner is a shell on this computer, so the path is typed into it and no remote-shell hint shows', async () => {
    for (const extra of [{}, { provider: 'codex' }, { shellOnly: true }] as Array<Partial<Session>>) {
      const label = JSON.stringify(extra)
      h.typeImagePathIntoShell.mockReset()
      usePasteHintStore.setState({ hints: {} })
      for (const el of paneEls) el.remove()
      paneEls = []
      mountPanes([['ss1', false], ['ss1-partner', true]])
      await altV([session('ss1', { sessionType: 'ssh', ...extra } as Partial<Session>)], 'ss1')
      expect(h.typeImagePathIntoShell, label).toHaveBeenCalledTimes(1)
      expect(h.typeImagePathIntoShell.mock.calls[0].slice(0, 2), label).toEqual(['ss1-partner', IMG])
      expect(h.sendImageToSession, label).not.toHaveBeenCalled()
      expect(h.sendImagePathToCodex, label).not.toHaveBeenCalled()
      expect(usePasteHintStore.getState().hints.ss1, label).toBeUndefined()
    }
  })

  it('the path is quoted for the shell the partner runs: PowerShell on Windows, a POSIX shell elsewhere', async () => {
    mountPanes([['cx1', false], ['cx1-partner', true]])
    for (const [platform, isWin32] of [['win32', true], ['linux', false], ['darwin', false]] as const) {
      ;(window as any).electronPlatform = platform
      h.typeImagePathIntoShell.mockReset()
      await altV([session('cx1', { provider: 'codex' } as Partial<Session>)], 'cx1')
      expect(h.typeImagePathIntoShell.mock.calls[0][2], platform).toBe(isWin32)
    }
  })

  it('the pane on screen when Alt+V is pressed is the target, even when the view changes while the image is saved', async () => {
    mountPanes([['cx1', false], ['cx1-partner', true]])
    saveImage.mockImplementation(async () => {
      // Back to the Codex view before the saved image comes back.
      paneEls[0].setAttribute('data-terminal-active', '')
      paneEls[1].removeAttribute('data-terminal-active')
      return { path: IMG }
    })
    await altV([session('cx1', { provider: 'codex' } as Partial<Session>)], 'cx1')
    expect(h.typeImagePathIntoShell).toHaveBeenCalledTimes(1)
    expect(h.typeImagePathIntoShell.mock.calls[0].slice(0, 2)).toEqual(['cx1-partner', IMG])
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
  })

  it('only this tab\'s own partner counts: another tab\'s partner marked on screen leaves this tab\'s route as it is', async () => {
    mountPanes([['cx1', false], ['cx2-partner', true]])
    await altV([session('cx1', { provider: 'codex' } as Partial<Session>), session('cx2', { provider: 'codex' } as Partial<Session>)], 'cx1')
    expect(h.sendImagePathToCodex).toHaveBeenCalledTimes(1)
    expect(h.sendImagePathToCodex.mock.calls[0].slice(0, 2)).toEqual(['cx1', IMG])
    expect(h.typeImagePathIntoShell).not.toHaveBeenCalled()
  })

  it('no image on the clipboard in the partner view: the same hint, and nothing typed into either terminal', async () => {
    mountPanes([['cx1', false], ['cx1-partner', true]])
    saveImage.mockResolvedValue({ error: 'no-image' })
    await altV([session('cx1', { provider: 'codex' } as Partial<Session>)], 'cx1')
    expect(h.typeImagePathIntoShell).not.toHaveBeenCalled()
    expect(h.sendImagePathToCodex).not.toHaveBeenCalled()
    expect(usePasteHintStore.getState().hints.cx1).toMatch(/No image in clipboard/)
  })

  // PR-level ADR-009 round 1 (A1): the partner shell is a plain shell main spawns the same way.
  it('macOS and Linux: the partner shell gets the same rule; a path it does not type shows where the image was saved, and the hidden session gets nothing', async () => {
    ;(window as any).electronPlatform = 'darwin'
    mountPanes([['cl6', false], ['cl6-partner', true]])
    saveImage.mockResolvedValue({ path: '/res/screenshots/clipboard-2.jpg', posixShell: 'other' })
    h.typeImagePathIntoShell.mockReturnValueOnce(false)
    await altV([session('cl6')], 'cl6')
    expect(h.typeImagePathIntoShell.mock.calls[0]).toEqual(['cl6-partner', '/res/screenshots/clipboard-2.jpg', false, 'other'])
    expect(h.sendImageToSession).not.toHaveBeenCalled()
    expect(usePasteHintStore.getState().hints.cl6).toBe('The image was saved on this computer at /res/screenshots/clipboard-2.jpg; nothing was typed into this terminal.')
  })
})
