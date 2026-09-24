// src/renderer/components/LaunchAckConfirm.tsx
// WP2 commit 6: the small confirm asked before a launch on an unverified
// sign-in -- the provider's own home shared with other apps on this
// computer, or any account nobody has vouched for. Asked on EVERY launch of
// such a session that the New session dialog did not start itself (a
// restart, a reopen, a multi-spawn copy): main refuses the launch without
// that launch's own acknowledgement, and nothing stores one. Driven by
// launchAckStore; renders the head of its queue. Cancel starts nothing.
//
// Consent is never given by accident:
//  - each answer names the question it answers (its request id), so a click
//    meant for one launch cannot land on the next one in the queue, and a
//    question withdrawn under the pointer answers nothing;
//  - for a moment after a question appears, clicks and keys on it are
//    ignored, so a double activation (or a key held from the last answer)
//    never answers a question the user has not read;
//  - focus starts on Cancel, never on the consent button.
import React, { useLayoutEffect, useRef } from 'react'
import { useLaunchAckStore } from '../stores/launchAckStore'
import { DialogOverlay, DialogPanel, DialogHeader, DialogBody, DialogFooter, DialogButton, useDialogEscape } from './ui/Dialog'

/** How long a new question ignores activations. */
export const LAUNCH_ACK_ARM_MS = 300

/** `suppressed`: a boot gate owns the screen. The queue is untouched; the
 *  awaiting launch keeps waiting and the confirm shows once the gates clear
 *  (the same rule as AccountLaunchGate). */
export default function LaunchAckConfirm({ suppressed = false }: { suppressed?: boolean }) {
  const pending = useLaunchAckStore((s) => s.queue[0] ?? null)
  const answer = useLaunchAckStore((s) => s.answer)
  const shown = !!pending && !suppressed
  const requestId = pending?.requestId
  // When the question on screen was shown, on the MONOTONIC clock: a wall
  // clock stepped backward (NTP after sleep, a VM resume) would otherwise
  // strand this question, and everything queued behind it, for as long as
  // the step. A reading earlier than `shownAt` cannot happen on a monotonic
  // clock; if it ever does, the question is armed rather than stranded.
  const shownAt = useRef<number | null>(null)
  // Layout effect: armed before the browser can deliver the next input.
  useLayoutEffect(() => {
    if (shown) shownAt.current = performance.now()
  }, [shown, requestId])
  const reply = (id: number, yes: boolean) => {
    const at = shownAt.current
    if (at !== null) {
      const since = performance.now() - at
      if (since >= 0 && since < LAUNCH_ACK_ARM_MS) return
    }
    answer(id, yes)
  }
  useDialogEscape(() => { if (requestId !== undefined) reply(requestId, false) }, shown)
  if (!pending || suppressed) return null

  const id = pending.requestId
  const sessionName = pending.sessionLabel || 'this session'
  const who = pending.email ? ` (${pending.email})` : ''
  const question = pending.unknown
    ? <>Launch {sessionName} on its saved Codex account?</>
    : pending.external
      ? <>Launch with the Codex sign-in already on this computer{who}?</>
      : <>Launch with {pending.accountName}{who}? Its sign-in is not verified.</>
  const why = pending.unknown
    ? 'This app could not read your accounts, so it cannot tell whether this sign-in needs confirming. Launching confirms it for this launch only.'
    : pending.external
      ? 'This app did not create that sign-in and cannot check who it belongs to, so every launch asks.'
      : 'This app cannot check who this account belongs to, so every launch asks.'
  return (
    <DialogOverlay z="z-[60]" dim={0.5} testId="launch-ack-overlay">
      <DialogPanel key={id} width="w-[440px]" labelledBy="launch-ack-title" describedBy="launch-ack-question" testId="launch-ack-confirm">
        <DialogHeader titleId="launch-ack-title" title="Start session" subtitle={<>Confirm the sign-in for <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{sessionName}</span></>} />
        <DialogBody>
          <p id="launch-ack-question" className="text-[12.5px] leading-snug" style={{ color: 'var(--text-primary)' }} data-testid="launch-ack-question">
            {question}
          </p>
          <p className="text-[11.5px] leading-snug mt-2" style={{ color: 'var(--text-muted)' }}>{why}</p>
        </DialogBody>
        <DialogFooter>
          <DialogButton variant="secondary" onClick={() => reply(id, false)} testId="launch-ack-cancel" title="Do not start this session" autoFocus>
            Cancel
          </DialogButton>
          <DialogButton variant="primary" onClick={() => reply(id, true)} testId="launch-ack-launch">
            Launch
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
