import React, { useEffect, useState } from 'react'
import type { DiagnosticsSnapshot, ServiceHealth } from '../../shared/service-health'

// No \u{...} escapes in JSX (esbuild doesn't support them). U+25C6 BLACK DIAMOND.
const DIAMOND = String.fromCodePoint(0x25c6)

type Tone = 'green' | 'amber' | 'red' | 'grey'

// Severity ordering: higher index = worse. Used by worst() to pick the
// most-alarming service across all supervised services (hooks + logging).
const STATE_SEVERITY: Record<string, number> = {
  listening: 0,
  stopped: 1,
  starting: 2,
  restarting: 3,
  degraded: 4,
  crashed: 5,
}

function worst(services: ServiceHealth[]): { tone: Tone; word: string | null; tip: string } {
  if (!services.length) return { tone: 'grey', word: null, tip: 'Services: unknown' }

  // Pick the service with the highest severity across ALL supervised services
  // (hooks + logging, and any future additions). Falls back to services[0] when
  // all severities are tied (e.g. all listening = green).
  const s = services.reduce((a, b) =>
    (STATE_SEVERITY[b.state] ?? 0) > (STATE_SEVERITY[a.state] ?? 0) ? b : a
  )

  const tip = `${s.label}: ${s.host} ${s.state}${s.port ? ' :' + s.port : ''} - ${s.inFlight} in-flight`
  switch (s.state) {
    case 'listening':
      return { tone: 'green', word: null, tip }
    case 'crashed':
      return { tone: 'red', word: 'Down', tip }
    case 'stopped':
      return { tone: 'grey', word: null, tip: `${s.label}: off` }
    default:
      // starting / restarting / degraded
      return {
        tone: 'amber',
        word: s.host === 'in-process-fallback' ? 'Fallback' : 'Degraded',
        tip,
      }
  }
}

const DOT: Record<Tone, string> = {
  green: 'bg-green',
  amber: 'bg-yellow',
  red: 'bg-red',
  grey: 'bg-overlay0',
}
const TXT: Record<Tone, string> = {
  green: 'text-overlay1',
  amber: 'text-yellow',
  red: 'text-red',
  grey: 'text-overlay0',
}

interface Props {
  open: boolean
  onOpen: () => void
}

export default function ConductorHealthPill({ open, onOpen }: Props) {
  const [snap, setSnap] = useState<DiagnosticsSnapshot | null>(null)

  useEffect(() => {
    let active = true
    window.electronAPI.serviceHealth.get().then((s) => {
      if (active) setSnap(s)
    })
    const unsub = window.electronAPI.serviceHealth.onUpdate((s) => setSnap(s))
    return () => {
      active = false
      unsub()
    }
  }, [])

  const w = worst(snap?.services ?? [])

  return (
    <button
      onClick={onOpen}
      data-conductor-pill
      className={`titlebar-no-drag flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors focus-ring ${
        open ? 'border-current bg-surface0/70' : 'border-surface0/60 bg-surface0/40'
      }`}
      title={w.tip}
      aria-expanded={open}
      aria-label="Services health and PTY integrity diagnostics"
    >
      <span className={`w-1.5 h-1.5 rounded-full ${DOT[w.tone]}`} />
      <span className={`text-[10px] font-medium leading-none ${TXT[w.tone]}`}>
        {DIAMOND} Services
      </span>
      {w.word && (
        <span className={`text-[10px] font-semibold leading-none ${TXT[w.tone]}`}>{w.word}</span>
      )}
    </button>
  )
}
