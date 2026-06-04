import React, { useEffect, useRef, useState, useCallback } from 'react'
import LogReplay, { type LogReplayHandle } from './LogReplay'
import { useLogsStore } from '../stores/useLogsStore'
import { useSessionStore } from '../stores/sessionStore'

interface Props {
  sessionId: string
}

/**
 * Per-session Logs alt pane (sibling of Draw/Web). Read-only replay of THIS
 * session's captured log from SQLite, a client-side find-in-session bar
 * (case + regex; the legacy type filter is intentionally dropped), and a
 * live-tail that polls readEvents ~1x/s while the pane is mounted (not gated on status).
 *
 * v1 NOTE (head-first): the replay loads from the start (no eventCount passed);
 * for a very long running session live-tail pages forward to catch the live end.
 * Tail-first for this pane is deferred (needs a per-session count query).
 *
 * NOTE (partner fold): the partner terminal is captured as a SEPARATE session
 * keyed `<sessionId>-partner`, so this pane shows only the base session's log.
 * The partner appears as its own row in the global Logs view.
 */
export default function LogsPane({ sessionId }: Props) {
  const togglePane = useLogsStore((s) => s.togglePane)
  const status = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.status)
  // The session is "alive" (capture may still append) in every state except disconnected.
  const isAlive = status !== undefined && status !== 'disconnected'

  const replayRef = useRef<LogReplayHandle>(null)
  const [find, setFind] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  // After-delete: set when a clear-all/prune removed this non-running session
  // while the pane is open (the global view broadcasts via a custom event).
  const [deleted, setDeleted] = useState(false)

  // Live-tail: poll LogReplay.appendNew ~1x/s while the pane is mounted. NOT gated
  // on Claude's working/idle status — output can arrive between turns; an ended
  // session just yields empty no-op reads. Stops on unmount / after-delete.
  useEffect(() => {
    if (deleted) return
    const id = setInterval(() => { void replayRef.current?.appendNew() }, 1000)
    return () => clearInterval(id)
  }, [deleted, sessionId])

  // Listen for an after-delete broadcast targeting this session.
  useEffect(() => {
    const onDeleted = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionIds: string[] }>).detail
      if (detail?.sessionIds?.includes(sessionId)) setDeleted(true)
    }
    window.addEventListener('logs:sessionsDeleted', onDeleted as EventListener)
    return () => window.removeEventListener('logs:sessionsDeleted', onDeleted as EventListener)
  }, [sessionId])
  // Reset the deleted flag if the user switches the pane to a different session.
  useEffect(() => { setDeleted(false) }, [sessionId])

  const handleClose = useCallback(() => togglePane(sessionId), [togglePane, sessionId])

  // Find-in-session: highlight/scroll-to in xterm would need the search addon;
  // v1 surfaces a match COUNT by scanning the loaded text (case + regex). For
  // seeing/jumping to matches across sessions, use the global Logs search.
  const [matchHint, setMatchHint] = useState<string | null>(null)
  const runFind = useCallback(async () => {
    if (!find.trim()) { setMatchHint(null); return }
    const rows = (await window.electronAPI.logsdb.readEvents(sessionId, 0, 5000)) as Array<{ text: string }>
    let n = 0
    let re: RegExp | null = null
    if (useRegex) { try { re = new RegExp(find, caseSensitive ? 'g' : 'gi') } catch { setMatchHint('Invalid regex'); return } }
    for (const r of rows) {
      const text = r.text || ''
      if (re) { const m = text.match(re); if (m) n += m.length }
      else if (caseSensitive ? text.includes(find) : text.toLowerCase().includes(find.toLowerCase())) n += 1
    }
    setMatchHint(`${n} match${n === 1 ? '' : 'es'}`)
  }, [find, useRegex, caseSensitive, sessionId])

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-surface-stage">
      {/* Find-in-session bar. */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-surface0 bg-crust shrink-0">
        <input
          type="text"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void runFind() } }}
          placeholder={useRegex ? 'Regex (Enter to count)' : 'Find in session (Enter)'}
          className="flex-1 min-w-0 bg-surface0/40 rounded-md px-2.5 py-1 text-xs text-text placeholder:text-overlay0 outline-none border border-transparent focus:border-blue/40 transition-colors font-mono"
        />
        <button
          onClick={() => setUseRegex((v) => !v)}
          className={`px-2 py-1 rounded-md text-[11px] font-mono font-bold transition-all shrink-0 ${useRegex ? 'bg-mauve/15 text-mauve border border-mauve/30' : 'text-overlay0 hover:text-overlay1 hover:bg-surface0/40 border border-transparent'}`}
          title="Toggle regex (.*)"
        >
          .*
        </button>
        <button
          onClick={() => setCaseSensitive((v) => !v)}
          className={`px-2 py-1 rounded-md text-[11px] font-semibold transition-all shrink-0 ${caseSensitive ? 'bg-blue/15 text-blue border border-blue/30' : 'text-overlay0 hover:text-overlay1 hover:bg-surface0/40 border border-transparent'}`}
          title="Toggle case sensitivity"
        >
          Aa
        </button>
        {matchHint && <span className="text-[10px] text-overlay1 tabular-nums shrink-0">{matchHint}</span>}
        <div className="flex-1" />
        {isAlive && !deleted && (
          <span className="flex items-center gap-1 text-[10px] text-green shrink-0" title="Live-tailing">
            <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
            Live
          </span>
        )}
        <button
          onClick={handleClose}
          className="px-2.5 py-0.5 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 hover:text-text transition-colors shrink-0"
          title="Close session logs"
        >
          Close
        </button>
      </div>
      {/* Head-first (no eventCount): loads from seq 0. Tail-first for this pane
          is deferred -- would need a per-session count query added to the IPC layer. */}
      <LogReplay ref={replayRef} sessionId={sessionId} deleted={deleted} />
    </div>
  )
}
