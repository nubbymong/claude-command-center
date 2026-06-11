import React from 'react'
import { useSentinelStore } from '../../stores/sentinelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { SentinelStateSnapshot } from '../../../../shared/sentinel-types'

// ── Pure helper (exported for unit tests) ────────────────────────────────────

export type DotState = 'hidden' | 'ok' | 'analyzing' | 'findings' | 'high'

export function deriveDotState(enabled: boolean, snap: SentinelStateSnapshot | null): DotState {
  if (!enabled || !snap) return 'hidden'
  if (snap.analyzing) return 'analyzing'
  const open = snap.findings.filter((f) => f.status === 'open')
  if (open.some((f) => f.kind === 'compat' && f.severity === 'high')) return 'high'
  if (open.length) return 'findings'
  return 'ok'
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SentinelDot() {
  const snap = useSentinelStore((s) => s.snap)
  const setPanelOpen = useSentinelStore((s) => s.setPanelOpen)
  const sentinelEnabled = useSettingsStore((s) => s.settings.sentinelEnabled !== false)

  const state = deriveDotState(sentinelEnabled, snap)

  if (state === 'hidden') return null

  const openCount = snap ? snap.findings.filter((f) => f.status === 'open').length : 0

  const dotColor =
    state === 'ok'
      ? 'bg-overlay0'
      : state === 'analyzing'
      ? 'bg-yellow animate-pulse'
      : state === 'high'
      ? 'bg-red'
      : 'bg-yellow' // findings

  const tooltip =
    state === 'ok'
      ? 'Sentinel: no issues found'
      : state === 'analyzing'
      ? 'Sentinel: analyzing Claude Code update…'
      : `Sentinel: ${openCount} open finding${openCount !== 1 ? 's' : ''}`

  return (
    <button
      onClick={() => setPanelOpen(true)}
      title={tooltip}
      className="flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-surface0/60 bg-surface0/40 hover:bg-surface1/60 transition-colors focus-ring"
    >
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
      {state === 'analyzing' && (
        <span className="text-[10px] text-yellow font-medium leading-none">Sentinel analyzing CC update…</span>
      )}
    </button>
  )
}
