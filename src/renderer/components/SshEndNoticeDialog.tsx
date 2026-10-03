import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useSshEndNoticeStore, SSH_END_NOTICE_ARM_MS } from '../stores/sshEndNoticeStore'
import { DialogOverlay, DialogPanel, DialogHeader, DialogBody, DialogFooter, DialogButton, useHoldEscape, WINDOW_CLOSE_Z } from './ui/Dialog'
import { useContainFocus } from '../onboarding/contain-focus'

// The one place an End result is shown (live T24, 2026-09-25): End finished,
// but Claude may still be running inside a rootful container, because sudo
// could not run the container engine without a password and none was saved
// in the config when the session started. The command shown was built from
// the session id and the validated container name (sshEndNoticeStore) and
// runs exactly what End's in-container kill runs, with a sudo that asks for
// the password. Queued: a second notice waits for the first to be closed.
//
// It opens 1 to 20 seconds after the tab closed, usually while the user is
// typing somewhere else, so nothing typed or clicked in passing may dismiss
// it unread:
//  - focus goes to the panel (tabIndex -1), never to a button, so a stray
//    Enter or Space does nothing;
//  - Escape and every button do nothing for SSH_END_NOTICE_ARM_MS after each
//    notice appears, timed on the monotonic clock (performance.now), so a
//    wall-clock step backwards (time sync, a resumed VM) cannot leave the
//    notice impossible to close while its overlay covers the window;
//  - Escape is the notice's alone while it shows: every Escape is stopped
//    and prevented at the window (capture phase), so none reaches a listener
//    underneath (the browser pane's Escape close, a dialog below). Only a
//    fresh press after the delay closes it: inside the delay, and for a held
//    key's repeats, the key is swallowed and nothing else happens. The
//    listener is added ONCE, when this component mounts (App renders it with
//    the main window's content, before any notice), and kept for its lifetime,
//    reading the notice state through refs: window listeners run in the order
//    they were added, so it runs before every capture listener a dialog adds
//    later (NoteDialog, CommandDialog, the command-bar menus), and its
//    stopImmediatePropagation keeps them from acting. It also holds Escape
//    (useHoldEscape), so a useDialogEscape dialog that registered earlier
//    leaves the key alone;
//  - it paints on the top layer (WINDOW_CLOSE_Z) and App renders it after the
//    close dialogs, so it is above every other dialog; it keeps Tab inside
//    itself (topmost), so a dialog underneath does not keep the keys;
//  - it is modal over the whole window: while it shows, focus that moves
//    anywhere outside it (a dialog opened after it, which would take the
//    focus underneath it) comes straight back to the panel;
//  - when the last notice closes, focus goes to the element that last tried
//    to take it while a notice showed, if it is still in the page, else back
//    to where it was before the first notice appeared, if that is still in
//    the page, else nowhere in particular.
export default function SshEndNoticeDialog() {
  const notice = useSshEndNoticeStore((s) => s.notices[0] ?? null)
  const dismiss = useSshEndNoticeStore((s) => s.dismiss)
  const [copied, setCopied] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  // When the notice on screen appeared (performance.now); see
  // SSH_END_NOTICE_ARM_MS.
  const shownAt = useRef(0)
  // Whether a notice is showing, where focus was before the first one took
  // it, and the element that last tried to take focus while one showed.
  const open = useRef(false)
  const focusBefore = useRef<HTMLElement | null>(null)
  const focusWanted = useRef<HTMLElement | null>(null)
  const armed = () => performance.now() - shownAt.current >= SSH_END_NOTICE_ARM_MS
  const close = useCallback(() => {
    if (performance.now() - shownAt.current >= SSH_END_NOTICE_ARM_MS) dismiss()
  }, [dismiss])
  useHoldEscape(!!notice)
  useContainFocus(panelRef, !!notice, { topmost: true })

  // The one Escape listener, for the component's lifetime (see above). It
  // reads whether a notice shows (`open`) and the current close through refs,
  // so nothing about it changes when a notice appears.
  const closeRef = useRef(close)
  useLayoutEffect(() => { closeRef.current = close }, [close])
  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !open.current) return
      e.stopImmediatePropagation()
      e.preventDefault()
      if (!e.repeat) closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const noticeId = notice?.id
  useLayoutEffect(() => {
    if (!noticeId) return
    const onFocusIn = (e: FocusEvent) => {
      const panel = panelRef.current
      const to = e.target
      if (!panel || !(to instanceof Node) || panel.contains(to)) return
      if (to instanceof HTMLElement) focusWanted.current = to
      panel.focus()
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [noticeId])
  useLayoutEffect(() => {
    if (!noticeId) {
      if (!open.current) return
      // The last notice closed: see the focus rule above.
      open.current = false
      const candidates = [focusWanted.current, focusBefore.current]
      focusWanted.current = null
      focusBefore.current = null
      // A candidate that is gone, or that will not take focus (disabled or
      // hidden by now), passes to the next.
      for (const el of candidates) {
        if (!el?.isConnected) continue
        el.focus()
        if (document.activeElement === el) break
      }
      return
    }
    shownAt.current = performance.now()
    setCopied(false)
    if (!open.current) {
      open.current = true
      const at = document.activeElement
      focusBefore.current = at instanceof HTMLElement && at !== document.body ? at : null
    }
    panelRef.current?.focus()
  }, [noticeId])

  if (!notice) return null

  const copy = async () => {
    if (!armed()) return
    try {
      await navigator.clipboard.writeText(notice.command)
      setCopied(true)
    } catch {
      /* clipboard blocked: the command stays on screen to select by hand */
    }
  }
  const mono = 'font-mono text-[11.5px]'
  const strong = { color: 'var(--text-primary)' }
  const host = notice.host
    ? <span className={mono} style={strong}>{notice.host}</span>
    : <>the SSH host</>

  return (
    <DialogOverlay z={WINDOW_CLOSE_Z} testId="ssh-end-notice">
      <DialogPanel width="w-[500px]" labelledBy="ssh-end-notice-title" role="alertdialog" testId="ssh-end-notice-panel" panelRef={panelRef} tabIndex={-1}>
        <DialogHeader
          titleId="ssh-end-notice-title"
          title="Claude may still be running in a container"
          onClose={close}
          closeTestId="ssh-end-notice-close"
        />
        <DialogBody>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }} data-testid="ssh-end-notice-text">
            The remote session was ended and its files on {host} removed, but Claude may still be running
            inside container <span className={mono} style={strong}>{notice.container}</span>: stopping it needs
            sudo, and no sudo password was saved in the config when this session started.
          </p>
          <p className="text-xs leading-relaxed mt-2" style={{ color: 'var(--text-secondary)' }} data-testid="ssh-end-notice-run">
            To stop Claude and remove its files in the container, run this on {host} (sudo asks for your password):
          </p>
          <pre
            className={`${mono} mt-2 px-2.5 py-2 rounded-md whitespace-pre-wrap break-all select-all`}
            style={{ background: 'var(--surface-sunken)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
            data-testid="ssh-end-notice-command"
          >
            {notice.command}
          </pre>
          <p className="text-xs leading-relaxed mt-2" style={{ color: 'var(--text-secondary)' }} data-testid="ssh-end-notice-save">
            To let End do this itself, save the sudo password in the config: <span style={strong}>Edit</span> the
            config, and in <span style={strong}>Runtime</span>, under <span style={strong}>The container engine needs sudo</span>,
            enter the <span style={strong}>Sudo password</span> with <span style={strong}>Save password</span> left
            ticked, then <span style={strong}>Save changes</span>. It applies to sessions started after that.
          </p>
        </DialogBody>
        <DialogFooter>
          <DialogButton onClick={() => void copy()} testId="ssh-end-notice-copy">{copied ? 'Copied' : 'Copy command'}</DialogButton>
          <DialogButton variant="primary" onClick={close} testId="ssh-end-notice-ok">Close</DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
