import { useEffect, useMemo, useRef, useState } from 'react'
import { useHooksStore } from '../../../stores/hooksStore'
import type { HookEvent, HookEventKind } from '../../../../shared/hook-types'

interface Props { sessionId: string }

const EMPTY: HookEvent[] = []

const KIND_LABEL: Record<HookEventKind, string> = {
  PreToolUse: 'Tool',
  PostToolUse: 'Tool',
  Notification: 'Notif',
  SessionStart: 'Start',
  Stop: 'Stop',
  PreCompact: 'Compact',
  SubagentStart: 'Task',
  SubagentStop: 'Task',
  StopFailure: 'Fail',
}

const KIND_COLOR: Record<HookEventKind, string> = {
  PreToolUse: 'text-blue',
  PostToolUse: 'text-blue',
  Notification: 'text-yellow',
  SessionStart: 'text-overlay1',
  Stop: 'text-overlay1',
  PreCompact: 'text-peach',
  SubagentStart: 'text-mauve',
  SubagentStop: 'text-mauve',
  StopFailure: 'text-red',
}

const ALL_KINDS = Object.keys(KIND_LABEL) as HookEventKind[]

export default function LiveActivityFooter({ sessionId }: Props) {
  const events = useHooksStore((s) => s.eventsBySession.get(sessionId) ?? EMPTY)
  const dropped = useHooksStore((s) => s.droppedBySession.get(sessionId) ?? false)
  const paused = useHooksStore((s) => s.paused)
  const filter = useHooksStore((s) => s.filter)
  const setPaused = useHooksStore((s) => s.setPaused)
  const setFilter = useHooksStore((s) => s.setFilter)
  const [expanded, setExpanded] = useState(false)
  const [pulseKey, setPulseKey] = useState(0)
  const lastLenRef = useRef(events.length)
  const [now, setNow] = useState(Date.now())
  // Snapshot of events frozen at the moment the user hit Pause. When paused,
  // the UI renders from this snapshot; the store keeps accumulating so
  // resuming reveals everything that arrived in the interim (per spec
  // §Expanded state). `null` means "not paused / use live events".
  const [pausedSnapshot, setPausedSnapshot] = useState<HookEvent[] | null>(null)

  useEffect(() => {
    let cancelled = false
    window.electronAPI.hooks.getBuffer(sessionId).then((buf: HookEvent[]) => {
      if (cancelled) return
      useHooksStore.getState().rehydrate(sessionId, buf)
    })
    return () => { cancelled = true }
  }, [sessionId])

  useEffect(() => {
    if (events.length > lastLenRef.current) setPulseKey((k) => k + 1)
    lastLenRef.current = events.length
  }, [events.length])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  // On pause: capture the current event list. On resume: drop the snapshot.
  useEffect(() => {
    if (paused) setPausedSnapshot(events)
    else setPausedSnapshot(null)
    // Intentionally NOT depending on `events` — snapshot is taken once at
    // the transition, not updated while paused.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused])

  const source = pausedSnapshot ?? events
  const visible = useMemo(() => {
    if (!filter) return source
    return source.filter((e) => filter.has(e.event as HookEventKind))
  }, [source, filter])

  const latest = events[events.length - 1]
  const agoLabel = latest ? relativeTime(now - latest.ts) : '-'

  return (
    <div className="border-t border-surface0 bg-mantle text-xs">
      <button
        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-surface0 transition-colors duration-150"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label="Toggle Live Activity"
      >
        <span className="flex items-center gap-2">
          <span className="text-overlay1">{expanded ? '▼' : '▶'}</span>
          <span className="text-text">Live Activity</span>
          {events.length > 0 && (
            <span
              key={pulseKey}
              className="w-1.5 h-1.5 rounded-full bg-green [animation:hooks-pulse_300ms_ease-out]"
              aria-hidden="true"
            />
          )}
        </span>
        <span className="text-overlay1 tabular-nums">
          {events.length} event{events.length === 1 ? '' : 's'} · {agoLabel}
        </span>
      </button>
      {expanded && (
        <ExpandedList
          events={visible}
          dropped={dropped}
          paused={paused}
          setPaused={setPaused}
          filter={filter}
          setFilter={setFilter}
        />
      )}
    </div>
  )
}

interface ExpandedProps {
  events: HookEvent[]
  dropped: boolean
  paused: boolean
  setPaused: (p: boolean) => void
  filter: Set<HookEventKind> | null
  setFilter: (f: Set<HookEventKind> | null) => void
}

function ExpandedList({ events, dropped, paused, setPaused, filter, setFilter }: ExpandedProps) {
  const visibleSlice = events.slice(-20).reverse()

  const toggleKind = (k: HookEventKind) => {
    if (!filter) {
      const next = new Set<HookEventKind>(ALL_KINDS)
      next.delete(k)
      setFilter(next)
      return
    }
    const next = new Set(filter)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    if (next.size === ALL_KINDS.length) setFilter(null)
    else setFilter(next)
  }

  return (
    <div className="bg-base px-3 py-2 space-y-2 max-h-[240px] overflow-y-auto transition-all duration-200">
      <div className="flex items-center justify-between gap-2">
        <div className="flex gap-1 flex-wrap">
          {ALL_KINDS.map((k) => {
            const active = filter === null || filter.has(k)
            return (
              <button
                key={k}
                onClick={() => toggleKind(k)}
                className={`px-1.5 py-0.5 rounded text-[10px] border border-surface0 transition-colors duration-150 ${
                  active ? 'bg-surface0 text-text' : 'bg-transparent text-overlay0'
                }`}
                aria-pressed={active}
              >
                {KIND_LABEL[k]}
              </button>
            )
          })}
        </div>
        <button
          onClick={() => setPaused(!paused)}
          className="px-2 py-0.5 rounded text-[10px] bg-surface0 text-text hover:bg-surface1 transition-colors duration-150"
          aria-pressed={paused}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
      </div>

      {dropped && (
        <div className="text-[10px] text-overlay0 italic">
          Older events dropped (ring buffer full)
        </div>
      )}

      {visibleSlice.length === 0 && (
        <div className="text-overlay1 italic text-xs">No events yet</div>
      )}

      <ul className="space-y-0.5 font-mono text-[11px]">
        {visibleSlice.map((e, i) => (
          <li key={`${e.ts}-${i}`} className="flex gap-2 items-baseline">
            <span className="text-overlay0 tabular-nums">{formatClock(e.ts)}</span>
            <span className={`${KIND_COLOR[e.event as HookEventKind] ?? 'text-overlay1'} w-14`}>
              {KIND_LABEL[e.event as HookEventKind] ?? e.event}
            </span>
            <span className="text-text truncate">{e.summary ?? e.toolName ?? ''}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function relativeTime(ms: number): string {
  if (ms < 1500) return 'just now'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  return `${Math.round(ms / 3_600_000)}h ago`
}

function formatClock(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString(undefined, { hour12: false })
}
