/**
 * The log of a GUI-subsystem tool run from the console-less main process
 * (#379). This is the panel that replaces the bleed: the same bytes that used
 * to land on top of the TUI, shown where they belong.
 *
 * Deliberately plain — a scrolling monospace transcript with stderr tinted, a
 * status line, and Cancel/Close. Subscribing to the push channels lives here
 * rather than in the command bar so a closed panel cannot leak a listener.
 */
import { useEffect, useRef, useState } from 'react'
import type { CapturedRunExit } from '../../shared/gui-exe'

export interface CapturedRunModalProps {
  runId: string
  /** What was run, for the header. */
  label: string
  command: string
  exePath: string | null
  onClose: () => void
}

interface Line {
  stream: 'stdout' | 'stderr'
  text: string
}

export default function CapturedRunModal({ runId, label, command, exePath, onClose }: CapturedRunModalProps) {
  const [chunks, setChunks] = useState<Line[]>([])
  const [exit, setExit] = useState<CapturedRunExit | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    const offData = window.electronAPI.exe.onRunData((c) => {
      if (c.runId !== runId) return
      setChunks((prev) => [...prev, { stream: c.stream, text: c.chunk }])
    })
    const offExit = window.electronAPI.exe.onRunExit((e) => {
      if (e.runId !== runId) return
      setExit(e)
    })
    return () => { offData(); offExit() }
  }, [runId])

  // Follow the tail, the way DebugPanel does.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chunks, exit])

  const running = exit === null

  const status = (() => {
    if (running) return 'Running…'
    if (exit?.error) return `Stopped: ${exit.error}`
    if (exit?.signal) return `Killed (${exit.signal})`
    // The issue's own worked example exits 0xFFFFFFFE on an argument error, which
    // Node reports as a large unsigned number. Show it as hex too — a tool's docs
    // will name it that way, and the decimal form is unrecognisable.
    const code = exit?.code
    if (typeof code === 'number' && code !== 0) {
      const hex = (code >>> 0).toString(16).toUpperCase()
      return `Exited with code ${code} (0x${hex})`
    }
    return 'Exited cleanly (0)'
  })()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'color-mix(in srgb, var(--color-base) 80%, transparent)' }}
      data-ux-id="captured-run-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="captured-run-title"
        data-ux-id="captured-run-dialog"
        className="bg-mantle border border-surface0 rounded-lg shadow-2xl w-full max-w-3xl mx-4 flex flex-col"
        style={{ maxHeight: '80vh' }}
      >
        <div className="p-4 border-b border-surface0">
          <h2 id="captured-run-title" className="text-sm font-semibold text-text">
            {label}
          </h2>
          <p className="text-[11px] font-mono break-all mt-1" style={{ color: 'var(--text-muted)' }}>
            {exePath ?? command}
          </p>
        </div>

        <div
          ref={scrollRef}
          data-ux-id="captured-run-output"
          className="flex-1 overflow-auto p-4 font-mono text-xs whitespace-pre-wrap break-words"
          style={{ background: 'var(--color-crust, #11111b)', minHeight: '12rem' }}
        >
          {chunks.length === 0 && running && (
            <span style={{ color: 'var(--text-muted)' }}>Waiting for output…</span>
          )}
          {chunks.length === 0 && !running && (
            <span style={{ color: 'var(--text-muted)' }}>That program printed nothing.</span>
          )}
          {chunks.map((c, i) => (
            <span key={i} className={c.stream === 'stderr' ? 'text-red' : 'text-text'}>
              {c.text}
            </span>
          ))}
        </div>

        <div className="p-4 border-t border-surface0 flex items-center gap-3">
          <span
            className="text-xs flex-1"
            data-ux-id="captured-run-status"
            style={{ color: running ? 'var(--text-secondary)' : 'var(--text-muted)' }}
          >
            {status}
            {exit?.truncated ? ' — output was truncated' : ''}
          </span>
          {running && (
            <button
              type="button"
              onClick={() => { void window.electronAPI.exe.cancelRun(runId) }}
              data-ux-id="captured-run-cancel"
              className="py-1.5 px-4 text-xs rounded bg-surface1 hover:bg-surface2 text-text transition-colors focus-ring"
            >
              Stop
            </button>
          )}
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            data-ux-id="captured-run-close"
            className="py-1.5 px-4 text-xs rounded bg-surface1 hover:bg-surface2 text-text transition-colors focus-ring"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
