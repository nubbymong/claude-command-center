import React from 'react'
import { useSentinelStore } from '../../stores/sentinelStore'
import { useSettingsStore } from '../../stores/settingsStore'
import type { SentinelStateSnapshot } from '../../../shared/sentinel-types'
import { findingReachesUser, type ReachabilityContext } from '../../../shared/sentinel-reachability'
import { isSentinelEnabled } from '../../../shared/sentinel-enabled'

// ── Pure helper (exported for unit tests) ────────────────────────────────────

// 'reviewed' = open findings exist, but NONE of them reach the user's setup
// (info / managed-only / mechanisms CCC doesn't use). It is a calm state — the
// alarming colours (amber 'findings', red 'high') are reserved for findings that
// would actually affect this install, so the colour means what the user expects.
export type DotState = 'hidden' | 'ok' | 'analyzing' | 'reviewed' | 'findings' | 'high'

export function deriveDotState(
  enabled: boolean,
  snap: SentinelStateSnapshot | null,
  ctx: ReachabilityContext = {},
): DotState {
  if (!enabled || !snap) return 'hidden'
  if (snap.analyzing) return 'analyzing'
  const open = snap.findings.filter((f) => f.status === 'open')
  const reaching = open.filter((f) => findingReachesUser(f, ctx))
  if (reaching.some((f) => f.severity === 'high')) return 'high'
  if (reaching.length) return 'findings'
  if (open.length) return 'reviewed'
  return 'ok'
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function SentinelDot() {
  const snap = useSentinelStore((s) => s.snap)
  const setPanelOpen = useSentinelStore((s) => s.setPanelOpen)
  const sentinelEnabled = useSettingsStore((s) => isSentinelEnabled(s.settings.sentinelEnabled))

  const state = deriveDotState(sentinelEnabled, snap)

  if (state === 'hidden') return null

  const openFindings = snap ? snap.findings.filter((f) => f.status === 'open') : []
  const openCount = openFindings.length
  // The count that drives the alarm — findings that actually reach this install.
  const reachingCount = openFindings.filter((fnd) => findingReachesUser(fnd)).length

  // Calm grey for 'ok' AND 'reviewed' (findings exist but none reach the user).
  // Amber/red are reserved for findings that would actually affect this setup.
  const dotColor =
    state === 'analyzing'
      ? 'bg-yellow animate-pulse'
      : state === 'high'
      ? 'bg-red'
      : state === 'findings'
      ? 'bg-yellow'
      : 'bg-overlay0' // ok + reviewed

  const tooltip =
    state === 'analyzing'
      ? 'Sentinel: analyzing Claude Code update…'
      : state === 'high' || state === 'findings'
      ? `Sentinel: ${reachingCount} change${reachingCount !== 1 ? 's' : ''} affecting your setup`
      : state === 'reviewed'
      ? `Sentinel: ${openCount} change${openCount !== 1 ? 's' : ''} reviewed — none affect your setup`
      : 'Sentinel: no issues found'

  return (
    <button
      onClick={() => setPanelOpen(true)}
      title={tooltip}
      className="flex items-center gap-1.5 px-1.5 py-0.5 rounded border border-surface0/60 bg-surface0/40 hover:bg-surface1/60 transition-colors focus-ring"
    >
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
      {/* Persistent label (spec §6 discoverability): an unlabelled 8px dot was
          invisible as a brand-new feature. States/colours/click unchanged. */}
      <span
        className={`text-[10px] font-medium leading-none ${
          state === 'analyzing' ? 'text-yellow' : state === 'high' ? 'text-red' : 'text-overlay1'
        }`}
      >
        {state === 'analyzing' ? 'Sentinel · analyzing…' : 'Sentinel'}
      </span>
    </button>
  )
}
