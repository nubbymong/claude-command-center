import React, { useEffect, useRef, useState, useCallback, useImperativeHandle, forwardRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { ReplaySanitizer } from '../lib/replay-sanitizer'

interface EventRow {
  id: number
  sessionId: string
  seq: number
  ts: number
  type: string
  raw: Uint8Array
  text: string
}

interface Props {
  sessionId: string
  /** Render the "these logs were deleted" state instead of replaying. */
  deleted?: boolean
  /** When live-tailing, the parent bumps this to trigger an append of new events. */
  tailNonce?: number
  /** Seek so the batch containing this seq is the first thing shown (search jump). */
  seekToSeq?: number
  /** Total events in the session (a STABLE snapshot taken when the replay opens,
   *  e.g. SessionRecord.eventCount). Lets the initial load start at the LAST page
   *  (tail-first) so appendNew() tails the live end. MUST NOT be a live-updating
   *  value: every change re-runs the initial load (clear + reload), fighting
   *  live-tail. Consumers pass the count captured at open, not a growing total. */
  eventCount?: number
}

export interface LogReplayHandle {
  /** Append any events at/after the current loaded offset (live-tail step). */
  appendNew: () => Promise<void>
}

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

// Shared log terminal theme (semantic tokens). Also consumed by SetupDialog.
export function buildLogTheme() {
  return {
    background:          readVar('--surface-stage', '#0f1218'),
    foreground:          readVar('--terminal-foreground', '#b8c5d6'),
    cursor:              readVar('--text-primary', '#F5E0DC'),
    cursorAccent:        readVar('--surface-stage', '#0f1218'),
    selectionBackground: readVar('--surface-overlay', '#2a3342'),
    selectionForeground: readVar('--text-primary', '#f0f4fc'),
    black:        readVar('--surface-overlay', '#2a3342'),
    red:          readVar('--status-danger', '#F38BA8'),
    green:        readVar('--status-success', '#A6E3A1'),
    yellow:       readVar('--status-warning', '#F9E2AF'),
    blue:         readVar('--status-info', '#89B4FA'),
    magenta:      readVar('--chart-other', '#CBA6F7'),
    cyan:         readVar('--accent', '#94E2D5'),
    white:        readVar('--text-secondary', '#b8c5d6'),
    brightBlack:  readVar('--text-muted', '#4a5568'),
    brightRed:    readVar('--status-danger', '#F38BA8'),
    brightGreen:  readVar('--status-success', '#A6E3A1'),
    brightYellow: readVar('--status-warning', '#F9E2AF'),
    brightBlue:   readVar('--status-info', '#89B4FA'),
    brightMagenta:readVar('--chart-other', '#CBA6F7'),
    brightCyan:   readVar('--accent', '#94E2D5'),
    brightWhite:  readVar('--text-primary', '#f0f4fc'),
  }
}

const PAGE = 1000

const LogReplay = forwardRef<LogReplayHandle, Props>(function LogReplay(
  { sessionId, deleted, tailNonce, seekToSeq, eventCount },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // Next read offset (seq-equivalent: events are gap-free per session).
  const loadedRef = useRef(0)
  const inFlightRef = useRef(false)      // serialize appendNew; no overlapping reads of loadedRef
  const initialDoneRef = useRef(false)   // tail must not run until the initial load owns offset 0
  // History-preserving replay: strip alt-screen switches, turn /clear wipes into
  // a visible divider (raw bytes played verbatim rendered the pane BLANK after
  // /clear — the data was intact, the replay re-applied the wipe). Stateful pair
  // (streaming UTF-8 decode + cross-chunk escape carry), reset per (re)load.
  const sanitizerRef = useRef(new ReplaySanitizer())
  const decoderRef = useRef(new TextDecoder())

  const writeSanitized = useCallback((term: Terminal, raw: Uint8Array) => {
    const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>)
    const safe = sanitizerRef.current.push(decoderRef.current.decode(u8, { stream: true }))
    if (safe) term.write(safe)
  }, [])
  const [loading, setLoading] = useState(true)
  const [isEmpty, setIsEmpty] = useState(false)

  // Terminal lifecycle — re-init per session.
  useEffect(() => {
    if (deleted) return
    const container = containerRef.current
    if (!container) return
    let disposed = false
    let resizeObserver: ResizeObserver | null = null

    const initTerminal = () => {
      if (disposed) return
      const rect = container.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) { requestAnimationFrame(initTerminal); return }
      const term = new Terminal({
        theme: buildLogTheme(),
        fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', Consolas, monospace",
        fontSize: 13,
        lineHeight: 1.2,
        scrollback: 10000,
        disableStdin: true,
        cursorStyle: 'bar',
        cursorBlink: false,
        cursorInactiveStyle: 'none',
      })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      termRef.current = term
      fitRef.current = fit
      requestAnimationFrame(() => { try { fit.fit() } catch { /* ignore */ } })
      resizeObserver = new ResizeObserver(() => { try { fit.fit() } catch { /* ignore */ } })
      resizeObserver.observe(container)
    }
    initTerminal()

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      termRef.current?.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId, deleted])

  // Initial load for this session.
  useEffect(() => {
    if (deleted) return
    let cancelled = false
    loadedRef.current = 0
    setLoading(true)
    setIsEmpty(false)
    initialDoneRef.current = false
    const run = async () => {
      let tries = 0
      while (!termRef.current && tries < 50) { await new Promise((r) => setTimeout(r, 50)); tries++ }
      const term = termRef.current
      // Initial offset: a search seek centers the hit; else when the total event
      // count is known load the LAST page (tail-first) so the newest output shows
      // and appendNew() tails the live end; else fall back to the start.
      const startOffset =
        typeof seekToSeq === 'number'
          ? Math.max(0, seekToSeq - Math.floor(PAGE / 2))
          : typeof eventCount === 'number'
            ? Math.max(0, eventCount - PAGE)
            : 0
      const rows = (await window.electronAPI.logsdb.readEvents(sessionId, startOffset, PAGE)) as EventRow[]
      if (cancelled) return
      if (rows.length === 0 && startOffset === 0) {
        setIsEmpty(true); setLoading(false); initialDoneRef.current = true; return
      }
      term?.clear()
      sanitizerRef.current = new ReplaySanitizer()
      decoderRef.current = new TextDecoder()
      if (term) for (const ev of rows) writeSanitized(term, ev.raw)
      loadedRef.current = startOffset + rows.length
      setLoading(false)
      initialDoneRef.current = true
    }
    run()
    return () => { cancelled = true }
  }, [sessionId, deleted, seekToSeq, eventCount, writeSanitized])

  const appendNew = useCallback(async () => {
    if (deleted || inFlightRef.current || !initialDoneRef.current) return
    const term = termRef.current
    if (!term) return
    inFlightRef.current = true
    try {
      const start = loadedRef.current
      const rows = (await window.electronAPI.logsdb.readEvents(sessionId, start, PAGE)) as EventRow[]
      if (rows.length === 0) return
      for (const ev of rows) writeSanitized(term, ev.raw)
      loadedRef.current = start + rows.length
      if (isEmpty) setIsEmpty(false)
    } finally {
      inFlightRef.current = false
    }
  }, [sessionId, deleted, isEmpty, writeSanitized])

  useImperativeHandle(ref, () => ({ appendNew }), [appendNew])

  // Live-tail / external nudge: when tailNonce changes, append new events.
  useEffect(() => {
    if (tailNonce === undefined) return
    void appendNew()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tailNonce])

  if (deleted) {
    return (
      <div className="flex-1 flex items-center justify-center bg-surface-stage">
        <p className="text-xs text-overlay0">These logs were deleted.</p>
      </div>
    )
  }

  return (
    <div className="flex-1 relative bg-surface-stage" style={{ minHeight: 200 }}>
      <div ref={containerRef} className="absolute inset-0" />
      {isEmpty && !loading && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-xs text-overlay0">No log output recorded for this session.</p>
        </div>
      )}
    </div>
  )
})

export default LogReplay
