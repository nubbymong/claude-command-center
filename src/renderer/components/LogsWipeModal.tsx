import React, { useEffect, useRef, useState } from 'react'
import { DialogOverlay, DialogPanel, DialogHeader, DialogBody, DialogFooter, DialogButton } from './ui/Dialog'

/**
 * LogsWipeModal — first-run BLOCKING confirm for the Logs v2 reset.
 *
 * The previous betas left two large, now-orphaned stores on disk that the new
 * transcript-only viewer never reads: the byte-capture `logs.db` (~21 GB) and the
 * legacy file-log tree (~16 GB), plus the import markers. There is NO reader for
 * that old data in the new build, so there is no "keep" option — a single confirm
 * proceeds with deletion. Claude's own conversation transcripts (the new data
 * source) are NOT affected.
 *
 * Flow: at startup App mounts this gated on a DETECT result. The modal shows the
 * detected total bytes, and on confirm calls CONFIRM (the actual deletion), then
 * signals the parent via onComplete so boot continues. Detection-driven +
 * idempotent: once wiped nothing is detected and this never re-appears.
 *
 * Shared dialog primitives, smooth 200ms enter/exit per the UX prefs. There is
 * deliberately no cancel path (and so no Escape): the wipe is the only way on.
 */

const CLOSE_ANIMATION_MS = 200

interface Props {
  /** Detected total bytes of the old artifacts (for the headline figure). */
  totalBytes: number
  /** Called after the wipe IPC resolves (or fails) so boot can continue. */
  onComplete: () => void
}

function formatGiB(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024)
  if (gib >= 0.1) return `${gib.toFixed(1)} GB`
  const mib = bytes / (1024 * 1024)
  if (mib >= 0.1) return `${mib.toFixed(1)} MB`
  return `${Math.max(0, Math.round(bytes / 1024))} KB`
}

export default function LogsWipeModal({ totalBytes, onComplete }: Props) {
  const [entering, setEntering] = useState(false)
  const [closing, setClosing] = useState(false)
  const [busy, setBusy] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntering(true))
    return () => cancelAnimationFrame(id)
  }, [])
  useEffect(() => () => { if (closeTimer.current !== null) clearTimeout(closeTimer.current) }, [])

  const proceed = async () => {
    if (busy || closing) return
    setBusy(true)
    try {
      await window.electronAPI.logsWipe.confirm()
    } catch {
      // Tolerate a failure: detection re-fires next launch (idempotent). We still
      // close so boot is never blocked on a transient delete error.
    }
    setClosing(true)
    closeTimer.current = setTimeout(onComplete, CLOSE_ANIMATION_MS)
  }

  const visible = entering && !closing

  return (
    <DialogOverlay className={`transition-opacity duration-200 ease-out ${visible ? 'opacity-100' : 'opacity-0'}`}>
      <DialogPanel
        labelledBy="logs-wipe-heading"
        width="w-full"
        style={{ maxWidth: '28rem' }}
        className={`transition-all duration-200 ease-out ${visible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2'}`}
      >
        <DialogHeader titleId="logs-wipe-heading" title="Beta log reset" />
        <DialogBody>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            AI Code Conductor&apos;s recorded terminal logs from previous betas will now be deleted
            ({formatGiB(totalBytes)}). This is not recoverable. Claude&apos;s own
            conversation transcripts are not affected.
          </p>
        </DialogBody>
        <DialogFooter>
          <DialogButton size="md" variant="primary" onClick={proceed} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete old logs'}
          </DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
