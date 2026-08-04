import React, { useState } from 'react'
import { useSentinelStore } from '../../stores/sentinelStore'
import type { SentinelFinding } from '../../../shared/sentinel-types'
import { selectBreakingFindings, surfaceLabel, formatFindingText, formatSentinelReportText } from './sentinel-report-text'

// ── Copy-to-clipboard button ──────────────────────────────────────────────────
// getText is a thunk so the (possibly large) report string is only built on
// click. Clipboard access can reject when the window isn't focused or OS policy
// blocks it — swallow so the click never surfaces as an unhandled rejection.

function CopyButton({
  getText,
  label = 'Copy',
  title,
  className,
}: {
  getText: () => string
  label?: string
  title?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(getText())
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — swallow */
    }
  }
  return (
    <button
      onClick={handleCopy}
      title={title ?? 'Copy to clipboard'}
      className={
        className ??
        'px-2 py-0.5 text-[11px] rounded bg-surface1/60 text-overlay1 hover:bg-surface2/60 transition-colors shrink-0'
      }
    >
      {copied ? 'Copied' : label}
    </button>
  )
}

// ── One severe breaking change ────────────────────────────────────────────────
// Every finding here is, by construction, a severe break (the AI pass and the
// deterministic backstop both emit kind 'compat'/'high'), so there is one flat
// list — no severity chips, no info/warn wall, no proposed-fix apply flow.

function BreakingRow({ finding }: { finding: SentinelFinding }) {
  const handleMute = () => {
    void window.electronAPI.sentinel.setStatus(finding.id, 'muted')
  }
  const sfc = surfaceLabel(finding.surface)

  return (
    <div className="py-2.5 border-b border-surface1/50 last:border-0">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-red/15 text-red shrink-0">breaking</span>
          <span className="text-xs font-medium text-text truncate">{finding.title}</span>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <CopyButton getText={() => formatFindingText(finding)} title="Copy this finding" />
          <button
            onClick={handleMute}
            className="px-2 py-0.5 text-[11px] rounded bg-surface1/60 text-overlay1 hover:bg-surface2/60 transition-colors"
          >
            Mute
          </button>
        </div>
      </div>
      {finding.badgeText && <p className="text-[11px] text-subtext0 mt-1">{finding.badgeText}</p>}
      <div className="flex items-center gap-1.5 flex-wrap mt-1">
        {sfc && (
          <span className="inline-block text-[10px] px-1.5 py-px rounded bg-surface1/60 text-overlay1">
            {sfc}
          </span>
        )}
      </div>
      <p className="text-[11px] text-overlay0 mt-1">{finding.evidence}</p>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function SentinelPanel() {
  const snap = useSentinelStore((s) => s.snap)
  const panelOpen = useSentinelStore((s) => s.panelOpen)
  const setPanelOpen = useSentinelStore((s) => s.setPanelOpen)

  if (!panelOpen) return null

  const breaking = selectBreakingFindings(snap)
  const version = snap?.lastSeenCcVersion ?? 'unknown'
  const subtitleDate = snap?.lastAnalysisAt
    ? new Date(snap.lastAnalysisAt).toLocaleString()
    : 'no analysis yet'
  const subtitle = `CC ${version} · ${snap?.analyzing ? 'analyzing…' : subtitleDate}`

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label="Sentinel"
      onClick={(e) => { if (e.target === e.currentTarget) setPanelOpen(false) }}
    >
      <div
        className="bg-surface0 rounded-xl border border-surface1 shadow-2xl w-[540px] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-surface1/70 shrink-0">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-text">Sentinel</h2>
            <p className="text-[11px] text-overlay0 mt-0.5">{subtitle}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {breaking.length > 0 && (
              <CopyButton
                getText={() => formatSentinelReportText(snap)}
                label="Copy"
                title="Copy the full report to the clipboard"
                className="px-2.5 py-1 text-[11px] rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 transition-colors"
              />
            )}
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

        {/* Calm degrade banner: a failed/timed-out AI pass, never raw stderr. */}
        {snap?.lastAnalysisError && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-lg bg-yellow/10 border border-yellow/30 text-[11px] text-yellow shrink-0">
            {snap.lastAnalysisError}
          </div>
        )}

        {/* Body: one honest state at a time. Never a green "compatible" verdict
            while analyzing or after a failed run (the AI didn't get to say). */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {breaking.length === 0 && snap?.analyzing && (
            <p className="text-xs text-overlay0 py-6 text-center">
              Analyzing the Claude Code update… this can take a few minutes.
            </p>
          )}

          {breaking.length === 0 && !snap?.analyzing && snap?.lastAnalysisError && (
            <p className="text-xs text-overlay0 py-6 text-center">
              The last analysis did not complete. No verdict yet; the deterministic checks still ran. Use Re-run to try again.
            </p>
          )}

          {breaking.length === 0 && !snap?.analyzing && !snap?.lastAnalysisError && (
            <div className="py-8 text-center">
              <svg
                width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className="text-green mx-auto mb-2"
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
              <p className="text-sm font-medium text-text">No breaking changes</p>
              <p className="text-xs text-overlay0 mt-0.5">Claude Code {version} is compatible with CCC.</p>
            </div>
          )}

          {breaking.length > 0 && (
            <section>
              <div className="flex items-center gap-1.5 mb-2">
                <svg
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red shrink-0"
                >
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <h3 className="text-xs font-semibold text-red">
                  {breaking.length} severe breaking change{breaking.length === 1 ? '' : 's'}
                </h3>
              </div>
              <div className="rounded-lg border border-red/30 bg-crust/30 px-3">
                {breaking.map((f) => (
                  <BreakingRow key={f.id} finding={f} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
