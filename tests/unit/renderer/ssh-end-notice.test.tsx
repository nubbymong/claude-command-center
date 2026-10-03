// @vitest-environment jsdom
/**
 * Live T24 (2026-09-25): End in a rootful container whose sudo password was
 * typed at the prompt, never saved, could not stop Claude inside it, yet said
 * nothing. End now resolves 'container-needs-sudo', and the renderer says so in
 * ONE place (SshEndNoticeDialog, fed by endRemoteAndReport): Claude may still
 * be running inside container <name>, the exact command that stops it (the
 * same in-container script End runs), and where to save the sudo password so
 * End can do it. Every End caller routes through endRemoteAndReport, calls it
 * BEFORE the local pty kill, and none of them waits for the result to close.
 *
 * The notice opens 1 to 20 seconds after the tab closed, usually while the
 * user types elsewhere, so it must not be dismissed by a key or click meant
 * for something else: focus goes to the panel (never a button), Escape and
 * its buttons do nothing for the first 800 ms (on the monotonic clock, so a
 * wall-clock step backwards cannot strand it), a held Escape's repeats are
 * ignored, every Escape stops at the notice while it shows (none reaches a
 * listener underneath), it paints above every other dialog and holds Escape
 * and Tab there, focus that moves outside it while it shows comes back to it,
 * and closing it returns focus (to where it was before, when the element that
 * tried to take it has gone).
 *
 * Mutations to prove these can fail: have requestCloseSession or
 * endRemoteAndClose call endRemote directly again (no notice), or after the
 * pty kill (call order); drop the endContainerSessionRemote call from
 * closeSessionBatch; build the command from the raw session id or an
 * unvalidated name; focus a button instead of the panel, drop the 800 ms
 * guard, time it on Date.now again, drop the repeat check, stop only the
 * Escapes that close it, drop the focusin guard, the Escape hold, the focus
 * return or its fallback, or WINDOW_CLOSE_Z; render the notice before the
 * close dialogs in App.tsx.
 */
import React from 'react'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import fs from 'node:fs'
import path from 'node:path'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const kill = vi.fn()
vi.mock('../../../src/renderer/ptyTracker', () => ({ killSessionPty: kill }))
vi.mock('../../../src/renderer/session-persistence', () => ({ persistSessionState: vi.fn(async () => {}) }))

const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const { requestCloseSession, endRemoteAndClose, useSshCloseStore } = await import('../../../src/renderer/stores/sshCloseStore')
const { closeSessionBatch } = await import('../../../src/renderer/utils/closeSessionBatch')
const { useSshEndNoticeStore, reportSshEndResult, endRemoteAndReport, SSH_END_NOTICE_ARM_MS } = await import('../../../src/renderer/stores/sshEndNoticeStore')
const { default: SshEndNoticeDialog } = await import('../../../src/renderer/components/SshEndNoticeDialog')
const { default: SshCloseDialog } = await import('../../../src/renderer/components/SshCloseDialog')
const { default: NoteDialog } = await import('../../../src/renderer/components/NoteDialog')
const { WINDOW_CLOSE_Z } = await import('../../../src/renderer/components/ui/Dialog')

// An odd session id (shell punctuation) and an odd but valid container name.
const ODD_SID = 'odd id;$(x)'
const ODD_NAME = 'web.app_1-x'
const NEEDS = { outcome: 'container-needs-sudo', container: { engine: 'docker', name: ODD_NAME, host: 'rocky.lan' } }
const EXPECTED =
  `sudo docker exec web.app_1-x sh -c '` +
  String.raw`rm -f ~/.claude/settings-odd_id___x_.json ~/.claude/mcp-odd_id___x_.json ~/.claude/ccc-status-odd_id___x_.url 2>/dev/null; exec pkill -f "/settings-odd_id___x_\.json"` +
  `'`

/** A promise the test resolves by hand, to prove callers do not wait on End. */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }

let container: HTMLDivElement
let root: Root
const byTest = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const setEndRemote = (fn: (...a: unknown[]) => unknown) => {
  ;(window as any).electronAPI = { ...((window as any).electronAPI ?? {}), ssh: { endRemote: vi.fn(fn) }, webview: { forget: vi.fn(async () => {}) } }
  return (window as any).electronAPI.ssh.endRemote as ReturnType<typeof vi.fn>
}
/** Past the notice's arming delay. The clock is fake (Date and performance
 *  only), so this moves both; a wall-clock step moves Date alone. */
const arm = () => { vi.advanceTimersByTime(SSH_END_NOTICE_ARM_MS) }
const key = async (k: string, target: Element | null = document.activeElement, opts: { repeat?: boolean } = {}) => {
  await act(async () => { (target ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, repeat: !!opts.repeat })) })
}
const zOf = (className: string): number | null => {
  const m = className.match(/(?:^|\s)z-(?:\[(\d+)\]|(\d+))(?=\s|$)/)
  return m ? Number(m[1] ?? m[2]) : null
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance'] })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  kill.mockClear()
  useSshEndNoticeStore.setState({ notices: [] })
  useSshCloseStore.setState({ pending: null } as never)
  useSessionStore.setState({ sessions: [] } as never)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('the End notice', () => {
  it('says where Claude may still be running, the exact stop command, and where to save the sudo password', async () => {
    reportSshEndResult(ODD_SID, NEEDS)
    await act(async () => { root.render(<SshEndNoticeDialog />) })
    const text = byTest('ssh-end-notice-panel')!.textContent ?? ''
    expect(byTest('ssh-end-notice-text')!.textContent).toBe(
      `The remote session was ended and its files on rocky.lan removed, but Claude may still be running inside container ${ODD_NAME}: stopping it needs sudo, and no sudo password was saved in the config when this session started.`,
    )
    expect(byTest('ssh-end-notice-run')!.textContent).toBe(
      'To stop Claude and remove its files in the container, run this on rocky.lan (sudo asks for your password):',
    )
    expect(byTest('ssh-end-notice-command')!.textContent).toBe(EXPECTED)
    // The real place to save it, with the config dialog's own labels (Save
    // password is ticked by default, so it is not an instruction), one name
    // for that place throughout, and that it applies to sessions started
    // afterwards.
    expect(byTest('ssh-end-notice-save')!.textContent).toBe(
      'To let End do this itself, save the sudo password in the config: Edit the config, and in Runtime, under The container engine needs sudo, ' +
      'enter the Sudo password with Save password left ticked, then Save changes. It applies to sessions started after that.',
    )
    expect(text).not.toContain('connection')
    expect(text).not.toMatch(/\btick Save password/)
    // Plain English: no em dash anywhere in the notice.
    expect(text).not.toContain(String.fromCharCode(0x2014))
    arm()
    await act(async () => { byTest('ssh-end-notice-ok')!.click() })
    expect(byTest('ssh-end-notice')).toBeNull()
    expect(useSshEndNoticeStore.getState().notices).toEqual([])
  })

  it('a host it cannot show plainly is "the SSH host", in both places, and the notice still shows', async () => {
    reportSshEndResult(ODD_SID, { ...NEEDS, container: { ...NEEDS.container, host: `b${String.fromCharCode(0xfc)}cher.example` } })
    reportSshEndResult('s2', { ...NEEDS, container: { ...NEEDS.container, host: 'x'.repeat(300) } })
    await act(async () => { root.render(<SshEndNoticeDialog />) })
    expect(byTest('ssh-end-notice-text')!.textContent).toContain('its files on the SSH host removed')
    expect(byTest('ssh-end-notice-run')!.textContent).toContain('run this on the SSH host (sudo')
    expect(byTest('ssh-end-notice-command')!.textContent).toBe(EXPECTED)
    expect(useSshEndNoticeStore.getState().notices).toHaveLength(2)
    expect(useSshEndNoticeStore.getState().notices.every((n) => n.host === undefined)).toBe(true)
  })

  it('Copy command copies exactly the command shown', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    reportSshEndResult(ODD_SID, NEEDS)
    await act(async () => { root.render(<SshEndNoticeDialog />) })
    arm()
    await act(async () => { byTest('ssh-end-notice-copy')!.click() })
    expect(writeText).toHaveBeenCalledWith(EXPECTED)
    expect(byTest('ssh-end-notice-copy')!.textContent).toBe('Copied')
  })

  it('shows nothing for an ordinary outcome or a malformed result', () => {
    for (const r of [{ outcome: 'completed' }, { outcome: 'failed' }, { outcome: 'no-target' }, undefined, null, 'container-needs-sudo',
      { outcome: 'container-needs-sudo' }, { ...NEEDS, container: { ...NEEDS.container, name: 'a b' } }]) {
      reportSshEndResult(ODD_SID, r)
    }
    expect(useSshEndNoticeStore.getState().notices).toEqual([])
  })

  it('says it once: two results queue, and the dialog shows one at a time', async () => {
    reportSshEndResult('s1', NEEDS)
    reportSshEndResult('s2', { ...NEEDS, container: { ...NEEDS.container, name: 'other' } })
    await act(async () => { root.render(<SshEndNoticeDialog />) })
    expect(document.querySelectorAll('[data-testid="ssh-end-notice-panel"]')).toHaveLength(1)
    expect(byTest('ssh-end-notice-command')!.textContent).toContain('docker exec web.app_1-x ')
    arm()
    await act(async () => { byTest('ssh-end-notice-ok')!.click() })
    expect(byTest('ssh-end-notice-command')!.textContent).toContain('docker exec other ')
  })
})

describe('the End notice is not dismissed by a key or click meant for something else', () => {
  it('focus lands on the panel, never on a button', async () => {
    const elsewhere = document.createElement('textarea')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    reportSshEndResult(ODD_SID, NEEDS)
    await act(async () => { root.render(<SshEndNoticeDialog />) })
    expect(document.activeElement).toBe(byTest('ssh-end-notice-panel'))
    expect(document.activeElement!.tagName).not.toBe('BUTTON')
    expect(byTest('ssh-end-notice-panel')!.getAttribute('tabindex')).toBe('-1')
  })

  it('an Escape and an Enter right after it appears do not dismiss it, nor do its buttons', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    reportSshEndResult(ODD_SID, NEEDS)
    await act(async () => { root.render(<SshEndNoticeDialog />) })
    await key('Escape')
    await key('Enter')
    await act(async () => { byTest('ssh-end-notice-ok')!.click() })
    await act(async () => { byTest('ssh-end-notice-close')!.click() })
    await act(async () => { byTest('ssh-end-notice-copy')!.click() })
    vi.advanceTimersByTime(SSH_END_NOTICE_ARM_MS - 1)
    await key('Escape')
    expect(byTest('ssh-end-notice')).not.toBeNull()
    expect(useSshEndNoticeStore.getState().notices).toHaveLength(1)
    expect(writeText).not.toHaveBeenCalled()
  })

  it('after 800 ms Escape closes it, and focus goes back to where it was', async () => {
    const elsewhere = document.createElement('textarea')
    document.body.appendChild(elsewhere)
    elsewhere.focus()
    reportSshEndResult(ODD_SID, NEEDS)
    await act(async () => { root.render(<SshEndNoticeDialog />) })
    expect(document.activeElement).not.toBe(elsewhere)
    arm()
    await key('Escape')
    expect(byTest('ssh-end-notice')).toBeNull()
    expect(document.activeElement).toBe(elsewhere)
  })

  it('each queued notice is guarded again when it appears', async () => {
    reportSshEndResult('s1', NEEDS)
    reportSshEndResult('s2', { ...NEEDS, container: { ...NEEDS.container, name: 'other' } })
    await act(async () => { root.render(<SshEndNoticeDialog />) })
    arm()
    await key('Escape')
    expect(byTest('ssh-end-notice-command')!.textContent).toContain('docker exec other ')
    await key('Escape')
    expect(byTest('ssh-end-notice-command')!.textContent).toContain('docker exec other ')
    arm()
    await key('Escape')
    expect(byTest('ssh-end-notice')).toBeNull()
  })

  // The arming delay runs on the monotonic clock. On the wall clock, a step
  // backwards after it appeared (time sync, a resumed VM) would keep it
  // unarmed for as long as the step, while its overlay covers the window.
  // Mutation to prove this can fail: time shownAt/close() with Date.now().
  it('a wall-clock step backwards after it appears does not stop it closing once 800 ms have passed', async () => {
    reportSshEndResult(ODD_SID, NEEDS)
    await act(async () => { root.render(<SshEndNoticeDialog />) })
    vi.setSystemTime(Date.now() - 60 * 60 * 1000)
    arm()
    await key('Escape')
    expect(byTest('ssh-end-notice')).toBeNull()
  })

  // A key held down from before it appeared (or through the delay) sends
  // repeats: none of them may close it once it is armed. Mutation to prove
  // this can fail: drop the `!e.repeat` check from the notice's Escape.
  it('an Escape held from inside the guard does not close it when the guard lapses; a fresh press does', async () => {
    reportSshEndResult(ODD_SID, NEEDS)
    await act(async () => { root.render(<SshEndNoticeDialog />) })
    await key('Escape')
    await key('Escape', document.activeElement, { repeat: true })
    arm()
    await key('Escape', document.activeElement, { repeat: true })
    await key('Escape', document.activeElement, { repeat: true })
    expect(byTest('ssh-end-notice')).not.toBeNull()
    await key('Escape')
    expect(byTest('ssh-end-notice')).toBeNull()
  })

  // While it shows, Escape is the notice's alone: a held key's repeats and a
  // press inside the delay are swallowed, not passed on. Underneath, App's
  // browser-pane handler closes the active session's pane on an Escape that
  // reaches the document and only defers to a `role="dialog"` modal (the
  // notice is an alertdialog), so a key the notice let through would close
  // the pane. Mutation to prove this can fail: stop and prevent only the
  // Escape that closes the notice (return before stopping on a repeat or
  // inside the delay).
  it('no Escape reaches a listener underneath while it shows: inside the delay, held repeats, or the press that closes it', async () => {
    const reached: string[] = []
    // The shape of App's browser-pane Escape handler (document, bubble phase).
    const paneClose = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
      reached.push(`document${e.repeat ? ' (repeat)' : ''}`)
    }
    const windowBubble = (e: KeyboardEvent) => { if (e.key === 'Escape') reached.push('window') }
    document.addEventListener('keydown', paneClose)
    window.addEventListener('keydown', windowBubble)
    try {
      reportSshEndResult(ODD_SID, NEEDS)
      await act(async () => { root.render(<SshEndNoticeDialog />) })
      const sent: KeyboardEvent[] = []
      const press = async (repeat: boolean) => {
        const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, repeat })
        sent.push(ev)
        await act(async () => { document.activeElement!.dispatchEvent(ev) })
      }
      await press(false) // inside the delay
      await press(true)
      arm()
      await press(true) // a held key, after the delay
      await press(true)
      expect(byTest('ssh-end-notice')).not.toBeNull()
      await press(false) // the fresh press that closes it
      expect(byTest('ssh-end-notice')).toBeNull()
      expect(reached).toEqual([])
      expect(sent.every((ev) => ev.defaultPrevented)).toBe(true)
      // Once it has closed, Escape reaches the page again.
      await key('Escape', document.body)
      expect(reached).toEqual(['document', 'window'])
    } finally {
      document.removeEventListener('keydown', paneClose)
      window.removeEventListener('keydown', windowBubble)
    }
  })

  // The element that last tried to take focus may be gone by the time the
  // notice closes (a dialog opened after it and closed again); focus then goes
  // back to where it was before the notice appeared. Mutation to prove this
  // can fail: return focus only to the element that last tried to take it.
  it('when the element that tried to take focus is gone, focus goes back to where it was before the notice', async () => {
    const before = document.createElement('textarea')
    document.body.appendChild(before)
    before.focus()
    reportSshEndResult(ODD_SID, NEEDS)
    await act(async () => { root.render(<SshEndNoticeDialog />) })
    const later = document.createElement('button')
    document.body.appendChild(later)
    await act(async () => { later.focus() })
    expect(document.activeElement).toBe(byTest('ssh-end-notice-panel'))
    later.remove()
    arm()
    await key('Escape')
    expect(byTest('ssh-end-notice')).toBeNull()
    expect(document.activeElement).toBe(before)
  })

  // Still in the page but no longer focusable (disabled, hidden by now): the
  // next candidate takes the focus instead. Mutation to prove this can fail:
  // stop at the first connected candidate without checking focus landed.
  it('when the element that tried to take focus will not take it back, focus goes back to where it was before the notice', async () => {
    const before = document.createElement('textarea')
    document.body.appendChild(before)
    before.focus()
    reportSshEndResult(ODD_SID, NEEDS)
    await act(async () => { root.render(<SshEndNoticeDialog />) })
    const later = document.createElement('button')
    document.body.appendChild(later)
    await act(async () => { later.focus() })
    expect(document.activeElement).toBe(byTest('ssh-end-notice-panel'))
    later.disabled = true
    arm()
    await key('Escape')
    expect(byTest('ssh-end-notice')).toBeNull()
    expect(later.isConnected).toBe(true)
    expect(document.activeElement).toBe(before)
  })
})

// The notice's Escape listener is added once, when the component mounts (App
// renders it with the main window's content), so it runs before every window capture listener
// a dialog adds later. Such a dialog (NoteDialog, CommandDialog, the
// command-bar menus) handles Escape itself with a raw capture listener, not
// useDialogEscape, so the Escape hold does not reach it; only running first,
// and stopping the key there, does. Mutation to prove these can fail: add the
// notice's listener per notice again (when a notice appears), after the
// dialog's.
describe('dialogs opened before a notice appears do not act on its Escapes', () => {
  it('a NoteDialog-shaped window capture listener added after the notice component mounted, before a notice appears, is never called', async () => {
    await act(async () => { root.render(<SshEndNoticeDialog />) })
    const onCancel = vi.fn()
    // NoteDialog.tsx's own listener: window capture, stopPropagation, then cancel.
    const noteEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', noteEscape, true)
    try {
      reportSshEndResult(ODD_SID, NEEDS)
      await act(async () => {})
      expect(byTest('ssh-end-notice')).not.toBeNull()
      await key('Escape') // inside the delay
      await key('Escape', document.activeElement, { repeat: true })
      arm()
      await key('Escape', document.activeElement, { repeat: true })
      await key('Escape') // the press that closes it
      expect(byTest('ssh-end-notice')).toBeNull()
      expect(onCancel).not.toHaveBeenCalled()
      // With no notice showing, the key is the dialog's again.
      await key('Escape', document.body)
      expect(onCancel).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', noteEscape, true)
    }
  })

  // The Escape hold is taken in the same commit that shows the notice (a
  // layout effect, like the notice's own state), so there is no frame between
  // the notice appearing and the hold where a useDialogEscape dialog that
  // registered earlier could take an Escape. The probe below sends its Escape
  // from a layout effect of that same commit, before any passive effect has
  // run. Mutation to prove this can fail: take the hold in useEffect.
  it('the Escape hold is in place in the same commit that shows the notice', async () => {
    function EscapeInSameCommit() {
      const shows = useSshEndNoticeStore((s) => s.notices.length > 0)
      React.useLayoutEffect(() => {
        if (shows) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      }, [shows])
      return null
    }
    useSshCloseStore.setState({ pending: { sessionId: 'p1', label: 'prod box', host: 'u@prod' } } as never)
    // The SSH close dialog's Escape is registered before the notice's own.
    await act(async () => { root.render(<SshCloseDialog />) })
    await act(async () => { root.render(<><SshCloseDialog /><SshEndNoticeDialog /><EscapeInSameCommit /></>) })
    await act(async () => { reportSshEndResult(ODD_SID, NEEDS) })
    expect(byTest('ssh-end-notice')).not.toBeNull()
    expect(useSshCloseStore.getState().pending).not.toBeNull()
  })

  it('the real NoteDialog, opened before a notice appears, keeps its unsaved text through the notice\'s Escapes', async () => {
    ;(window as any).electronAPI = { ...((window as any).electronAPI ?? {}), notes: { list: vi.fn(async () => []), load: vi.fn(async () => ''), save: vi.fn(async () => true), delete: vi.fn(async () => true) } }
    const onCancel = vi.fn()
    await act(async () => { root.render(<SshEndNoticeDialog />) })
    await act(async () => { root.render(<><SshEndNoticeDialog /><NoteDialog configId="cfg" onSave={vi.fn()} onCancel={onCancel} /></>) })
    const content = byTest('note-content') as HTMLTextAreaElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    await act(async () => { setValue.call(content, 'unsaved draft'); content.dispatchEvent(new Event('input', { bubbles: true })) })
    content.focus()
    reportSshEndResult(ODD_SID, NEEDS)
    await act(async () => {})
    expect(document.activeElement).toBe(byTest('ssh-end-notice-panel'))
    await key('Escape') // a stray Escape inside the delay
    await key('Escape', document.activeElement, { repeat: true })
    arm()
    await key('Escape')
    expect(byTest('ssh-end-notice')).toBeNull()
    expect(onCancel).not.toHaveBeenCalled()
    expect((byTest('note-content') as HTMLTextAreaElement).value).toBe('unsaved draft')
    expect(document.activeElement).toBe(byTest('note-content'))
  })
})

describe('the End notice is above every other dialog', () => {
  it('paints on the top layer, and App renders it after both close dialogs (same layer: the later paints above)', async () => {
    useSshCloseStore.setState({ pending: { sessionId: 'p1', label: 'prod box', host: 'u@prod' } } as never)
    reportSshEndResult(ODD_SID, NEEDS)
    await act(async () => { root.render(<><SshCloseDialog /><SshEndNoticeDialog /></>) })
    const layer = zOf(WINDOW_CLOSE_Z)!
    expect(zOf(byTest('ssh-end-notice')!.className)).toBe(layer)
    expect(zOf(byTest('ssh-close-dialog')!.className)).toBe(layer)
    const app = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/App.tsx'), 'utf8')
    const noticeAt = app.indexOf('<SshEndNoticeDialog />')
    expect(noticeAt).toBeGreaterThan(app.indexOf('<SshCloseDialog />'))
    expect(noticeAt).toBeGreaterThan(app.indexOf('<CloseDialog'))
  })

  it('over an open SSH close dialog: it takes the focus and the keys, Escape closes only the notice, and focus goes back', async () => {
    useSshCloseStore.setState({ pending: { sessionId: 'p1', label: 'prod box', host: 'u@prod' } } as never)
    await act(async () => { root.render(<><SshCloseDialog /><SshEndNoticeDialog /></>) })
    expect(document.activeElement).toBe(byTest('ssh-close-leave'))
    // The End result arrives while the close dialog is open.
    await act(async () => { reportSshEndResult(ODD_SID, NEEDS) })
    expect(document.activeElement).toBe(byTest('ssh-end-notice-panel'))
    // An early Escape reaches neither: the notice holds the key and is not armed.
    await key('Escape')
    expect(byTest('ssh-end-notice')).not.toBeNull()
    expect(useSshCloseStore.getState().pending).not.toBeNull()
    // Tab stays inside the notice (the close dialog's trap gives way to it).
    await key('Tab')
    expect(byTest('ssh-end-notice-panel')!.contains(document.activeElement)).toBe(true)
    arm()
    await key('Escape', byTest('ssh-end-notice-panel'))
    expect(byTest('ssh-end-notice')).toBeNull()
    expect(useSshCloseStore.getState().pending).not.toBeNull()
    expect(document.activeElement).toBe(byTest('ssh-close-leave'))
  })

  // A dialog opened AFTER the notice (Ctrl+W on a persistent SSH tab opens
  // the SSH close dialog) paints under it, yet would take the focus with its
  // own autofocus, so Enter or Space would act on a button nobody can see.
  // The notice is modal over the whole window: focus comes back to it, and
  // goes to that dialog once the notice closes. Mutation to prove this can
  // fail: drop the notice's focusin listener.
  it('a dialog opened after it cannot take the focus from under it; that dialog gets the focus when the notice closes', async () => {
    const terminal = document.createElement('textarea')
    document.body.appendChild(terminal)
    reportSshEndResult(ODD_SID, NEEDS)
    await act(async () => { root.render(<><SshCloseDialog /><SshEndNoticeDialog /></>) })
    expect(document.activeElement).toBe(byTest('ssh-end-notice-panel'))
    // Anything else that takes the focus while it shows gives it straight back.
    await act(async () => { terminal.focus() })
    expect(document.activeElement).toBe(byTest('ssh-end-notice-panel'))
    // The SSH close dialog opens after it, with its own autofocus.
    await act(async () => { useSshCloseStore.setState({ pending: { sessionId: 'p1', label: 'prod box', host: 'u@prod' } } as never) })
    expect(byTest('ssh-close-dialog')).not.toBeNull()
    expect(document.activeElement).toBe(byTest('ssh-end-notice-panel'))
    // So an Enter meant for something else reaches no hidden button.
    await key('Enter')
    expect(useSshCloseStore.getState().pending).not.toBeNull()
    arm()
    await key('Escape')
    expect(byTest('ssh-end-notice')).toBeNull()
    expect(useSshCloseStore.getState().pending).not.toBeNull()
    expect(document.activeElement).toBe(byTest('ssh-close-leave'))
  })
})

describe('every End caller routes the result to the notice, calls End before the pty kill, and does not wait for it', () => {
  const rootful = {
    id: ODD_SID, configId: 'cfg-c', sessionType: 'ssh', label: 'container', workingDirectory: '~', createdAt: 0,
    color: 'blue', status: 'idle', model: '', sshTmuxPersistent: false,
    sshConfig: { host: 'rocky.lan', port: 22, username: 'user', remotePath: '~', runtime: { type: 'container', engine: 'docker', container: ODD_NAME, sudo: true } },
  }

  it('closing a container session tab: End first, then the kill, the tab goes at once, and the notice follows', async () => {
    const d = deferred<unknown>()
    const endRemote = setEndRemote(() => d.promise)
    useSessionStore.setState({ sessions: [rootful] } as never)
    requestCloseSession(ODD_SID)
    expect(endRemote).toHaveBeenCalledWith({ sessionId: ODD_SID, configId: 'cfg-c' })
    expect(kill).toHaveBeenCalledWith(ODD_SID)
    expect(endRemote.mock.invocationCallOrder[0]).toBeLessThan(kill.mock.invocationCallOrder[0])
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useSshEndNoticeStore.getState().notices).toEqual([])
    d.resolve(NEEDS)
    await flush()
    expect(useSshEndNoticeStore.getState().notices.map((n) => n.command)).toEqual([EXPECTED])
  })

  it('End remote from the close dialog: End first, then the kill, the tab goes without waiting, and the notice follows', async () => {
    const d = deferred<unknown>()
    const endRemote = setEndRemote(() => d.promise)
    useSessionStore.setState({ sessions: [{ ...rootful, sshTmuxPersistent: true }] } as never)
    await endRemoteAndClose(ODD_SID)
    expect(endRemote).toHaveBeenCalledWith(ODD_SID)
    expect(kill).toHaveBeenCalledWith(ODD_SID)
    expect(endRemote.mock.invocationCallOrder[0]).toBeLessThan(kill.mock.invocationCallOrder[0])
    d.resolve(NEEDS)
    await flush()
    expect(useSshEndNoticeStore.getState().notices.map((n) => n.command)).toEqual([EXPECTED])
  })

  it('closing several sessions at once: a container session gets End before its kill; every other session closes as before', async () => {
    const d = deferred<unknown>()
    const endRemote = setEndRemote(() => d.promise)
    const plainSsh = { ...rootful, id: 'p1', sshConfig: { host: 'pi.local', port: 22, username: 'u', remotePath: '~' } }
    const persistent = { ...plainSsh, id: 'pp1', sshTmuxPersistent: true }
    const local = { ...rootful, id: 'l1', sessionType: 'local', sshConfig: undefined }
    useSessionStore.setState({ sessions: [plainSsh, rootful, persistent, local] } as never)
    closeSessionBatch(['p1', ODD_SID, 'pp1', 'l1'])
    expect(endRemote).toHaveBeenCalledTimes(1)
    expect(endRemote).toHaveBeenCalledWith({ sessionId: ODD_SID, configId: 'cfg-c' })
    const killOf = (id: string) => kill.mock.invocationCallOrder[kill.mock.calls.findIndex((c) => c[0] === id)]
    expect(endRemote.mock.invocationCallOrder[0]).toBeLessThan(killOf(ODD_SID))
    expect(kill.mock.calls.map((c) => c[0])).toEqual(['p1', ODD_SID, 'pp1', 'l1'])
    expect(useSessionStore.getState().sessions).toEqual([])
    // No close dialog for the persistent one: a bulk close detaches, as before.
    expect(useSshCloseStore.getState().pending).toBeNull()
    d.resolve(NEEDS)
    await flush()
    expect(useSshEndNoticeStore.getState().notices.map((n) => n.command)).toEqual([EXPECTED])
  })

  it('a failed invoke or a missing preload shows nothing and never throws', async () => {
    setEndRemote(() => Promise.reject(new Error('ipc gone')))
    expect(() => endRemoteAndReport(ODD_SID, ODD_SID)).not.toThrow()
    ;(window as any).electronAPI = undefined
    expect(() => endRemoteAndReport(ODD_SID, ODD_SID)).not.toThrow()
    await flush()
    expect(useSshEndNoticeStore.getState().notices).toEqual([])
  })
})
