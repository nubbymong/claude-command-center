import React, { useEffect, useState } from 'react'
import type { DiagnosticsSnapshot, ServiceHealth } from '../../shared/service-health'

// No \u{...} escapes in JSX (esbuild doesn't support them). U+25C6 BLACK DIAMOND.
const DIAMOND = String.fromCodePoint(0x25c6)

type Tone = 'green' | 'amber' | 'red' | 'grey'

function worst(services: ServiceHealth[]): { tone: Tone; word: string | null; tip: string } {
  if (!services.length) return { tone: 'grey', word: null, tip: 'Services: unknown' }
  // Hooks is the only supervised service today; generalize to worst-of when >1.
  const s = services[0]
  const tip = `Hooks: ${s.host} ${s.state}${s.port ? ' :' + s.port : ''} - ${s.inFlight} in-flight`
  switch (s.state) {
    case 'listening':
      return { tone: 'green', word: null, tip }
    case 'crashed':
      return { tone: 'red', word: 'Down', tip }
    case 'stopped':
      return { tone: 'grey', word: null, tip: 'Hooks: off' }
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
      className={`titlebar-no-drag flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors focus-ring ${
        open ? 'border-current bg-surface0/70' : 'border-surface0/60 bg-surface0/40'
      }`}
      title={w.tip}
      aria-expanded={open}
      aria-label="Services health"
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
