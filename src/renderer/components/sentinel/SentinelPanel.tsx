import React, { useCallback, useState } from 'react'
import { useSentinelStore } from '../../stores/sentinelStore'
import type { SentinelFinding } from '../../../shared/sentinel-types'
import { selectBreakingFindings, surfaceLabel, formatFindingText, formatSentinelReportText } from './sentinel-report-text'
import {
  DialogOverlay,
  DialogPanel,
  DialogHeader,
  DialogBody,
  DialogButton,
  DialogCallout,
  useDialogEscape,
} from '../ui/Dialog'

const TITLE_ID = 'sentinel-panel-title'

// ── Copy-to-clipboard button ──────────────────────────────────────────────────
// getText is a thunk so the (possibly large) report string is only built on
// click. Clipboard access can reject when the window isn't focused or OS policy
// blocks it — swallow so the click never surfaces as an unhandled rejection.

function CopyButton({
  getText,
  label = 'Copy',
  title,
}: {
  getText: () => string
  label?: string
  title?: string
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
    <DialogButton onClick={handleCopy} title={title ?? 'Copy to clipboard'}>
      {copied ? 'Copied' : label}
    </DialogButton>
  )
}

// ── Findings ─────────────────────────────────────────────────────────────────
// NOT all findings here are severe breaks (2026-09-02): the AI pass and the
// deterministic backstop emit 'compat'/'high', but the model-coverage check
// deliberately emits 'compat'/'warn' ("a new model exists" breaks nothing
// running — sentinel-models.ts says so in as many words). The chip and the
// header read the SEVERITY, so a housekeeping notice no longer impersonates a
// severe breaking change. One flat list still; no apply flow.

function BreakingRow({ finding }: { finding: SentinelFinding }) {
  const handleMute = () => {
    void window.electronAPI.sentinel.setStatus(finding.id, 'muted')
  }
  const sfc = surfaceLabel(finding.surface)
  const severe = finding.severity === 'high'

  return (
    <div className="py-2.5 border-b last:border-0" style={{ borderColor: 'var(--border-subtle)' }}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full shrink-0"
            style={{
              background: `color-mix(in srgb, ${severe ? 'var(--status-danger)' : 'var(--status-warning)'} 16%, transparent)`,
              color: severe ? 'var(--status-danger)' : 'var(--status-warning)',
            }}
          >
            {severe ? 'breaking' : 'notice'}
          </span>
          <span className="text-xs font-medium truncate" style={{ color: 'var(--text-primary)' }}>
            {finding.title}
          </span>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <CopyButton getText={() => formatFindingText(finding)} title="Copy this finding" />
          <DialogButton onClick={handleMute}>Mute</DialogButton>
        </div>
      </div>
      {finding.badgeText && (
        <p className="text-[11px] mt-1" style={{ color: 'var(--text-secondary)' }}>
          {finding.badgeText}
        </p>
      )}
      <div className="flex items-center gap-1.5 flex-wrap mt-1">
        {sfc && (
          <span
            className="inline-block text-[10px] px-1.5 py-px rounded"
            style={{ background: 'var(--surface-overlay)', color: 'var(--text-muted)' }}
          >
            {sfc}
          </span>
        )}
      </div>
      <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
        {finding.evidence}
      </p>
    </div>
  )
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function SentinelPanel() {
  const snap = useSentinelStore((s) => s.snap)
  const panelOpen = useSentinelStore((s) => s.panelOpen)
  const setPanelOpen = useSentinelStore((s) => s.setPanelOpen)

  const close = useCallback(() => setPanelOpen(false), [setPanelOpen])
  // Escape is now the keyboard way out. The backdrop used to close on click,
  // which the house rule forbids (Ctrl+C in a terminal fires click events and
  // ate the dialog) — the close glyph and Escape are the exits.
  useDialogEscape(panelOpen ? close : undefined)

  if (!panelOpen) return null

  const breaking = selectBreakingFindings(snap)
  const version = snap?.lastSeenCcVersion ?? 'unknown'
  const subtitleDate = snap?.lastAnalysisAt
    ? new Date(snap.lastAnalysisAt).toLocaleString()
    : 'no analysis yet'
  const subtitle = `CC ${version} · ${snap?.analyzing ? 'analyzing…' : subtitleDate}`

  return (
    <DialogOverlay dim={0.5}>
      <DialogPanel width="w-[540px]" labelledBy={TITLE_ID} style={{ maxHeight: '80vh' }}>
        <DialogHeader
          titleId={TITLE_ID}
          title="Sentinel"
          subtitle={subtitle}
          onClose={close}
          closeLabel="Close Sentinel panel"
          right={
            <div className="flex items-center gap-2 shrink-0">
              {breaking.length > 0 && (
                <CopyButton
                  getText={() => formatSentinelReportText(snap)}
                  label="Copy"
                  title="Copy the full report to the clipboard"
                />
              )}
              <DialogButton
                onClick={() => void window.electronAPI.sentinel.rerun()}
                disabled={!!snap?.analyzing}
                title="Re-run analysis now"
              >
                Re-run
              </DialogButton>
            </div>
          }
        />

        {/* Calm degrade banner: a failed/timed-out AI pass, never raw stderr. */}
        {snap?.lastAnalysisError && (
          <div className="px-[18px] pt-3 shrink-0">
            <DialogCallout tone="warning">{snap.lastAnalysisError}</DialogCallout>
          </div>
        )}

        {/* Body: one honest state at a time. Never a green "compatible" verdict
            while analyzing or after a failed run (the AI didn't get to say). */}
        <DialogBody className="flex-1">
          {breaking.length === 0 && snap?.analyzing && (
            <p className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
              Analyzing the Claude Code update… this can take a few minutes.
            </p>
          )}

          {breaking.length === 0 && !snap?.analyzing && snap?.lastAnalysisError && (
            <p className="text-xs py-6 text-center" style={{ color: 'var(--text-muted)' }}>
              The last analysis did not complete. No verdict yet; the deterministic checks still ran. Use Re-run to try again.
            </p>
          )}

          {breaking.length === 0 && !snap?.analyzing && !snap?.lastAnalysisError && (
            <div className="py-8 text-center">
              <svg
                width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className="mx-auto mb-2"
                style={{ color: 'var(--status-success)' }}
              >
                <path d="M20 6 9 17l-5-5" />
              </svg>
              <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>No breaking changes</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                Claude Code {version} is compatible with AI Code Conductor.
              </p>
            </div>
          )}

          {breaking.length > 0 && (() => {
            // Severity-honest header (2026-09-02): only 'high' findings are
            // severe breaks; 'warn' findings are compatibility notices, and a
            // notice-only panel must not shout in red.
            const severeCount = breaking.filter((f) => f.severity === 'high').length
            const noticeCount = breaking.length - severeCount
            const tone = severeCount > 0 ? 'var(--status-danger)' : 'var(--status-warning)'
            const parts: string[] = []
            if (severeCount > 0) parts.push(`${severeCount} severe breaking change${severeCount === 1 ? '' : 's'}`)
            if (noticeCount > 0) parts.push(`${noticeCount} compatibility notice${noticeCount === 1 ? '' : 's'}`)
            return (
            <section>
              <div className="flex items-center gap-1.5 mb-2">
                <svg
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0"
                  style={{ color: tone }}
                >
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                <h3 className="text-xs font-semibold" style={{ color: tone }} data-ux-id="sentinel-findings-heading">
                  {parts.join(' · ')}
                </h3>
              </div>
              <div
                className="rounded-lg border px-3"
                style={{
                  borderColor: `color-mix(in srgb, ${tone} 30%, transparent)`,
                  background: 'var(--surface-sunken)',
                }}
              >
                {breaking.map((f) => (
                  <BreakingRow key={f.id} finding={f} />
                ))}
              </div>
            </section>
            )
          })()}
        </DialogBody>
      </DialogPanel>
    </DialogOverlay>
  )
}
