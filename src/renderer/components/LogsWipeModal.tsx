import React, { useEffect, useRef, useState } from 'react'

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
 * V2 Catppuccin tokens, smooth 200ms enter/exit per the UX prefs.
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
  const backdropClass = `fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ease-out ${visible ? 'opacity-100' : 'opacity-0'}`
  const dialogClass = `bg-mantle rounded-lg shadow-2xl border border-surface0 w-full max-w-md flex flex-col transition-all duration-200 ease-out ${visible ? 'opacity-100 scale-100 translate-y-0' : 'opacity-0 scale-95 translate-y-2'}`

  return (
    <div className={backdropClass} role="dialog" aria-modal="true" aria-labelledby="logs-wipe-heading">
      <div className={dialogClass}>
        <div className="p-5 border-b border-surface0">
          <h2 id="logs-wipe-heading" className="text-base font-semibold text-text">
            Beta log reset
          </h2>
        </div>
        <div className="p-5">
          <p className="text-sm leading-relaxed text-subtext1">
            CCC&apos;s recorded terminal logs from previous betas will now be deleted
            ({formatGiB(totalBytes)}). This is not recoverable. Claude&apos;s own
            conversation transcripts are not affected.
          </p>
        </div>
        <div className="p-5 pt-0 flex items-center justify-end">
          <button
            onClick={proceed}
            disabled={busy}
            className="px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-60"
            style={{ background: 'var(--color-blue)', color: 'var(--color-crust)' }}
          >
            {busy ? 'Deleting…' : 'Delete old logs'}
          </button>
        </div>
      </div>
    </div>
  )
}
