/**
 * Pure helpers for the CCC Sentinel panel: section selection + plain-text
 * rendering of findings so the panel can offer "Copy" (the modal had no way to
 * get the report text out). Kept pure + framework-free so it is unit-tested
 * without rendering, and so the panel and the copy buttons share ONE definition
 * of "what is shown" — copy output can never drift from the rendered report.
 * No default export (project convention).
 */
import type { SentinelFinding, SentinelStateSnapshot } from '../../../shared/sentinel-types'

export interface SentinelSections {
  proposals: SentinelFinding[]
  compatFindings: SentinelFinding[]
  applied: SentinelFinding[]
}

/**
 * Partition a snapshot's findings the same way SentinelPanel renders them:
 *   - proposals     = open registry-proposal findings
 *   - compatFindings = open compat/info findings
 *   - applied       = findings with status 'applied'
 * dismissed/muted are excluded. A null snapshot yields empty sections.
 */
export function selectSentinelSections(snap: SentinelStateSnapshot | null): SentinelSections {
  const findings = snap?.findings ?? []
  return {
    proposals: findings.filter((f) => f.kind === 'registry-proposal' && f.status === 'open'),
    compatFindings: findings.filter((f) => (f.kind === 'compat' || f.kind === 'info') && f.status === 'open'),
    applied: findings.filter((f) => f.status === 'applied'),
  }
}

/** One finding as copyable plain text: a severity/title head line, the evidence,
 *  and (for proposals) the proposed patch JSON. */
export function formatFindingText(finding: SentinelFinding): string {
  const head = `[${finding.severity.toUpperCase()}] ${finding.title}${finding.affectedFeature ? ` (${finding.affectedFeature})` : ''}`
  const lines = [head]
  if (finding.evidence) lines.push(finding.evidence)
  if (finding.proposedPatch) lines.push(JSON.stringify(finding.proposedPatch, null, 2))
  return lines.join('\n')
}

/** The whole report as copyable plain text — header + only the non-empty
 *  sections, mirroring what the panel shows. */
export function formatSentinelReportText(snap: SentinelStateSnapshot | null): string {
  const { proposals, compatFindings, applied } = selectSentinelSections(snap)
  const version = snap?.lastSeenCcVersion ?? 'unknown'
  const when = snap?.lastAnalysisAt ? new Date(snap.lastAnalysisAt).toISOString() : 'no analysis yet'

  const out: string[] = ['CCC Sentinel — Compatibility Report', `CC ${version} · ${when}`, '']

  if (proposals.length > 0) {
    out.push('## Proposed fixes')
    for (const f of proposals) out.push(formatFindingText(f), '')
  }
  if (compatFindings.length > 0) {
    out.push('## Compatibility report')
    for (const f of compatFindings) out.push(formatFindingText(f), '')
  }
  if (applied.length > 0) {
    out.push('## Applied')
    for (const f of applied) out.push(`- ${f.title}`)
    out.push('')
  }
  if (proposals.length === 0 && compatFindings.length === 0 && applied.length === 0) {
    out.push('No findings — Claude Code and CCC look compatible.')
  }

  return out.join('\n').trim() + '\n'
}
