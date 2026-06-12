import React, { useState } from 'react'
import { useSentinelStore } from '../../stores/sentinelStore'
import type { SentinelFinding } from '../../../shared/sentinel-types'

// ── Per-row apply error state ─────────────────────────────────────────────────

function SeverityChip({ severity }: { severity: SentinelFinding['severity'] }) {
  const cls =
    severity === 'high'
      ? 'bg-red/15 text-red'
      : severity === 'warn'
      ? 'bg-yellow/15 text-yellow'
      : 'bg-overlay0/20 text-overlay1'
  return (
    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${cls}`}>
      {severity}
    </span>
  )
}

function ProposalRow({ finding }: { finding: SentinelFinding }) {
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  const handleApply = async () => {
    setApplyError(null)
    setApplying(true)
    try {
      const r = await window.electronAPI.sentinel.apply(finding.id)
      if (!r.ok) setApplyError(r.error ?? 'Apply failed')
    } finally {
      setApplying(false)
    }
  }

  const handleDismiss = () => {
    void window.electronAPI.sentinel.setStatus(finding.id, 'dismissed')
  }

  return (
    <div className="py-2.5 border-b border-surface1/50 last:border-0">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-text">{finding.title}</span>
        <div className="flex gap-1.5 shrink-0">
          <button
            onClick={handleApply}
            disabled={applying}
            className="px-2 py-0.5 text-[11px] rounded bg-blue/15 text-blue hover:bg-blue/25 transition-colors disabled:opacity-50"
          >
            {applying ? 'Applying…' : 'Apply'}
          </button>
          <button
            onClick={handleDismiss}
            className="px-2 py-0.5 text-[11px] rounded bg-surface1/60 text-overlay1 hover:bg-surface2/60 transition-colors"
          >
            Dismiss
          </button>
        </div>
      </div>
      <p className="text-[11px] text-overlay0 mt-0.5 truncate">{finding.evidence}</p>
      {finding.proposedPatch && (
        <pre className="mt-1.5 max-h-40 overflow-auto rounded bg-crust/60 border border-surface0/60 p-2 text-[10px] text-subtext0 font-mono leading-relaxed">
          {JSON.stringify(finding.proposedPatch, null, 2)}
        </pre>
      )}
      {applyError && (
        <p className="mt-1 text-[11px] text-red">{applyError}</p>
      )}
    </div>
  )
}

function CompatRow({ finding }: { finding: SentinelFinding }) {
  const handleMute = () => {
    void window.electronAPI.sentinel.setStatus(finding.id, 'muted')
  }

  return (
    <div className="py-2.5 border-b border-surface1/50 last:border-0">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <SeverityChip severity={finding.severity} />
          <span className="text-xs font-medium text-text truncate">{finding.title}</span>
        </div>
        <button
          onClick={handleMute}
          className="px-2 py-0.5 text-[11px] rounded bg-surface1/60 text-overlay1 hover:bg-surface2/60 transition-colors shrink-0"
        >
          Mute
        </button>
      </div>
      {finding.affectedFeature && (
        <span className="inline-block mt-0.5 text-[10px] px-1.5 py-px rounded bg-surface1/60 text-overlay1">
          {finding.affectedFeature}
        </span>
      )}
      <p className="text-[11px] text-overlay0 mt-0.5">{finding.evidence}</p>
    </div>
  )
}

function AppliedRow({ finding }: { finding: SentinelFinding }) {
  const handleRevert = () => {
    void window.electronAPI.sentinel.revert(finding.id)
  }

  return (
    <div className="py-2.5 border-b border-surface1/50 last:border-0">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs text-subtext0">{finding.title}</span>
        <button
          onClick={handleRevert}
          className="px-2 py-0.5 text-[11px] rounded bg-surface1/60 text-overlay1 hover:bg-red/15 hover:text-red transition-colors shrink-0"
        >
          Revert
        </button>
      </div>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function SentinelPanel() {
  const snap = useSentinelStore((s) => s.snap)
  const panelOpen = useSentinelStore((s) => s.panelOpen)
  const setPanelOpen = useSentinelStore((s) => s.setPanelOpen)

  if (!panelOpen) return null

  const proposals = snap
    ? snap.findings.filter((f) => f.kind === 'registry-proposal' && f.status === 'open')
    : []
  const compatFindings = snap
    ? snap.findings.filter((f) => (f.kind === 'compat' || f.kind === 'info') && f.status === 'open')
    : []
  const applied = snap ? snap.findings.filter((f) => f.status === 'applied') : []
  const hasAny = proposals.length > 0 || compatFindings.length > 0 || applied.length > 0

  const subtitleDate = snap?.lastAnalysisAt
    ? new Date(snap.lastAnalysisAt).toLocaleString()
    : 'no analysis yet'
  const subtitle = `CC ${snap?.lastSeenCcVersion ?? 'unknown'} · ${snap?.analyzing ? 'analyzing…' : subtitleDate}`

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label="CCC Sentinel findings"
      onClick={(e) => { if (e.target === e.currentTarget) setPanelOpen(false) }}
    >
      <div
        className="bg-surface0 rounded-xl border border-surface1 shadow-2xl w-[540px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-surface1/70 shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text">CCC Sentinel</h2>
            <p className="text-[11px] text-overlay0 mt-0.5">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => void window.electronAPI.sentinel.rerun()}
              disabled={!!snap?.analyzing}
              className="px-2.5 py-1 text-[11px] rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 transition-colors disabled:opacity-50 disabled:pointer-events-none"
              title="Re-run analysis now"
            >
              Re-run
            </button>
            <button
              onClick={() => setPanelOpen(false)}
              className="p-1.5 rounded text-overlay1 hover:text-text hover:bg-surface1 transition-colors"
              aria-label="Close Sentinel panel"
            >
              <svg width="12" height="12" viewBox="0 0 12 12">
                <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2" />
                <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            </button>
          </div>
        </div>

        {/* Error banner */}
        {snap?.lastAnalysisError && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-lg bg-yellow/10 border border-yellow/30 text-[11px] text-yellow shrink-0">
            {snap.lastAnalysisError}
          </div>
        )}

        {/* Body. Three honest empty states: in-progress, failed, clean. The old
            single "looks compatible" line rendered DURING analysis and next to
            a failure banner — both read as a finished green verdict. */}
        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-4">
          {!hasAny && snap?.analyzing && (
            <p className="text-xs text-overlay0 py-4 text-center">
              Analyzing the Claude Code update… this can take a few minutes.
            </p>
          )}
          {!hasAny && !snap?.analyzing && snap?.lastAnalysisError && (
            <p className="text-xs text-overlay0 py-4 text-center">
              The last analysis did not complete — no verdict yet. Use Re-run to try again.
            </p>
          )}
          {!hasAny && !snap?.analyzing && !snap?.lastAnalysisError && (
            <p className="text-xs text-overlay0 py-4 text-center">
              No findings — Claude Code and CCC look compatible.
            </p>
          )}

          {proposals.length > 0 && (
            <section>
              <h3 className="text-[11px] font-semibold text-overlay1 uppercase tracking-wide mb-1">
                Proposed fixes
              </h3>
              <div className="rounded-lg border border-surface1/60 bg-crust/30 px-3">
                {proposals.map((f) => (
                  <ProposalRow key={f.id} finding={f} />
                ))}
              </div>
            </section>
          )}

          {compatFindings.length > 0 && (
            <section>
              <h3 className="text-[11px] font-semibold text-overlay1 uppercase tracking-wide mb-1">
                Compatibility report
              </h3>
              <div className="rounded-lg border border-surface1/60 bg-crust/30 px-3">
                {compatFindings.map((f) => (
                  <CompatRow key={f.id} finding={f} />
                ))}
              </div>
            </section>
          )}

          {applied.length > 0 && (
            <section>
              <h3 className="text-[11px] font-semibold text-overlay1 uppercase tracking-wide mb-1">
                Applied
              </h3>
              <div className="rounded-lg border border-surface1/60 bg-crust/30 px-3">
                {applied.map((f) => (
                  <AppliedRow key={f.id} finding={f} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
