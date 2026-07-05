/**
 * Pure helpers for the CCC Sentinel panel (severe-breaking-only): the open
 * breaking findings + plain-text rendering, so the panel's Copy buttons and the
 * rendered list share ONE definition of what is shown (copy can never drift from
 * the rendered report). Kept pure + framework-free so it is unit-tested without
 * rendering. No default export (project convention).
 */
import type { SentinelFinding, SentinelStateSnapshot } from '../../../shared/sentinel-types'

const SURFACE_LABEL: Record<number, string> = {
  1: 'session launch',
  2: 'terminal embedding',
  3: 'statusline hook',
  4: 'config & account files',
}

/** Human label for a breaking finding's CCC surface (1-4), or null. */
export function surfaceLabel(surface?: number): string | null {
  return surface != null ? (SURFACE_LABEL[surface] ?? null) : null
}

/**
 * The open severe-breaking findings the panel lists. Both the AI pass and the
 * deterministic backstop produce kind 'compat'; dismissed/muted are excluded and
 * any legacy info / registry-proposal findings are filtered out. Null snap -> [].
 */
export function selectBreakingFindings(snap: SentinelStateSnapshot | null): SentinelFinding[] {
  return (snap?.findings ?? []).filter((f) => f.kind === 'compat' && f.status === 'open')
}

/** One finding as copyable plain text: title (+ surface), what breaks, evidence. */
export function formatFindingText(finding: SentinelFinding): string {
  const sfc = surfaceLabel(finding.surface)
  const lines = [`[BREAKING] ${finding.title}${sfc ? ` (${sfc})` : ''}`]
  if (finding.badgeText) lines.push(finding.badgeText)   // whatBreaks
  if (finding.evidence) lines.push(finding.evidence)
  return lines.join('\n')
}

/** The whole report as copyable plain text: header + each breaking change, or a
 *  clean all-clear line. */
export function formatSentinelReportText(snap: SentinelStateSnapshot | null): string {
  const breaking = selectBreakingFindings(snap)
  const version = snap?.lastSeenCcVersion ?? 'unknown'
  const when = snap?.lastAnalysisAt ? new Date(snap.lastAnalysisAt).toISOString() : 'no analysis yet'
  const out: string[] = ['CCC Sentinel: Breaking Changes', `CC ${version} · ${when}`, '']
  if (breaking.length === 0) {
    out.push(`No breaking changes. Claude Code ${version} is compatible.`)
  } else {
    for (const f of breaking) out.push(formatFindingText(f), '')
  }
  return out.join('\n').trim() + '\n'
}
