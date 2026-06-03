import React, { useEffect, useRef, useState } from 'react'
import type {
  DiagnosticsSnapshot,
  ServiceHealth,
  ServiceLogEntry,
} from '../../shared/service-health'

// No \u{...} escapes in JSX (esbuild). U+21BB CLOCKWISE OPEN CIRCLE ARROW,
// U+29C9 TWO JOINED SQUARES, U+25CB WHITE CIRCLE.
const RESTART_GLYPH = String.fromCodePoint(0x21bb)
const COPY_GLYPH = String.fromCodePoint(0x29c9)
const HOLLOW = String.fromCodePoint(0x25cb)

const STATE_DOT: Record<string, string> = {
  listening: 'bg-green',
  starting: 'bg-yellow',
  restarting: 'bg-yellow',
  degraded: 'bg-yellow',
  crashed: 'bg-red',
  stopped: 'bg-overlay0',
}
const LOG_TXT: Record<string, string> = {
  info: 'text-subtext0',
  warn: 'text-yellow',
  error: 'text-red',
}

function uptime(startedAt: number | null): string {
  if (!startedAt) return '-'
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-px">
      <span className="text-[9px] uppercase tracking-wide text-overlay1">{label}</span>
      <span className="text-[11px] text-text tabular-nums">{value}</span>
    </div>
  )
}

function ServiceCard({ s }: { s: ServiceHealth }) {
  return (
    <div className="rounded border border-surface0 bg-crust/50 p-2.5">
      <div className="flex items-center gap-1.5 mb-2">
        <span className={`w-2 h-2 rounded-full ${STATE_DOT[s.state] ?? 'bg-overlay0'}`} />
        <span className="text-[12px] font-semibold text-text">{s.label}</span>
        <span className="text-[10px] text-subtext0">
          {s.host}
          {s.port ? ` :${s.port}` : ''}
          {s.state !== 'listening' ? ` (${s.state})` : ''}
        </span>
      </div>
      <div className="grid grid-cols-4 gap-x-2 gap-y-1.5">
        <Metric label="PID" value={s.pid ?? '-'} />
        <Metric label="Uptime" value={uptime(s.startedAt)} />
        <Metric label="In-flight" value={s.inFlight} />
        <Metric label="Restarts" value={s.restartCount} />
        <Metric label="Events" value={s.eventsTotal} />
        <Metric label="Drops" value={s.dropsTotal} />
        <Metric label="Thrput/s" value={s.throughputPerSec} />
        <Metric label="Jank m/c" value={`${s.mainLoopStallsLastMin}/${s.childLoopStallsLastMin}`} />
      </div>
      {s.lastError && (
        <div className="mt-2 text-[10px] text-red break-words">
          last error: {s.lastError.message}
        </div>
      )}
    </div>
  )
}

function LogTail({ log }: { log: ServiceLogEntry[] }) {
  return (
    <div className="rounded border border-surface0 bg-crust/50 max-h-32 overflow-y-auto p-1.5 font-mono text-[10px] leading-snug">
      {log.length === 0 ? (
        <div className="text-overlay1">no log entries</div>
      ) : (
        log.map((e, i) => (
          <div key={i} className={`${LOG_TXT[e.level] ?? 'text-subtext0'} whitespace-pre-wrap break-words`}>
            <span className="text-overlay1">{e.code} </span>
            {e.message}
          </div>
        ))
      )}
    </div>
  )
}

export default function ConductorServicesPanel({ onClose }: { onClose: () => void }) {
  const [snap, setSnap] = useState<DiagnosticsSnapshot | null>(null)
  const [entered, setEntered] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    window.electronAPI.serviceHealth.get().then((s) => { if (active) setSnap(s) })
    const unsub = window.electronAPI.serviceHealth.onUpdate((s) => setSnap(s))
    // Trigger the enter transition on the next frame.
    const t = setTimeout(() => setEntered(true), 0)
    return () => { active = false; unsub(); clearTimeout(t) }
  }, [])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      // The pill button owns its own open/close toggle; ignore clicks on it so
      // the toggle isn't fought by this close-on-outside handler.
      if (target.closest?.('[data-conductor-pill]')) return
      if (ref.current && !ref.current.contains(target)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  const services = snap?.services ?? []
  const inFallback = services[0]?.host === 'in-process-fallback'

  const handleRestart = () => { void window.electronAPI.serviceHealth.restart('hooks') }
  const handleCopy = () => {
    if (snap) void navigator.clipboard?.writeText(JSON.stringify(snap, null, 2))
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Services diagnostics"
      className={`absolute right-0 top-full mt-1.5 z-50 w-80 rounded-lg border border-surface0 bg-mantle shadow-xl p-3 flex flex-col gap-2.5 transition-all duration-200 ease-out ${
        entered ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-1'
      }`}
    >
      {services.map((s) => (
        <ServiceCard key={s.id} s={s} />
      ))}
      <LogTail log={snap?.log ?? []} />
      <div
        className="rounded border border-surface0/60 bg-crust/30 px-2.5 py-1.5 text-[11px] text-overlay1 flex items-center gap-1.5"
        title="MCP relocation is a future phase"
      >
        <span>{HOLLOW}</span>
        <span>MCP server</span>
        <span className="text-overlay0">in-process :19333 (next phase)</span>
      </div>
      <div className="flex items-center gap-2 pt-0.5">
        <button
          onClick={handleRestart}
          disabled={inFallback}
          title={inFallback ? 'Relaunch the app to retry the supervised gateway' : 'Restart the hooks gateway'}
          className="flex-1 px-2 py-1 rounded border border-surface0 bg-surface0/40 text-[11px] text-text transition-colors hover:bg-surface0/70 disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
        >
          {RESTART_GLYPH} Restart
        </button>
        <button
          onClick={handleCopy}
          title="Copy the full diagnostics snapshot as JSON"
          className="flex-1 px-2 py-1 rounded border border-surface0 bg-surface0/40 text-[11px] text-text transition-colors hover:bg-surface0/70 focus-ring"
        >
          {COPY_GLYPH} Copy diagnostics
        </button>
      </div>
    </div>
  )
}
