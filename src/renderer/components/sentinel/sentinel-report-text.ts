/**
 * Pure helpers for the Sentinel panel (severe-breaking-only): the open
 * breaking findings + plain-text rendering, so the panel's Copy buttons and the
 * rendered list share ONE definition of what is shown (copy can never drift from
 * the rendered report). Kept pure + framework-free so it is unit-tested without
 * rendering. No default export (project convention).
 */
import type { SentinelFinding, SentinelStateSnapshot } from '../../../shared/sentinel-types'
import { findingReachesUser, type ReachabilityContext } from '../../../shared/sentinel-reachability'

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
 * The open breaking findings the panel and the Copy report surface. A finding
 * shows only when it is open AND actually reaches the user's install
 * (`findingReachesUser`) -- the SAME gate the dot uses, so the panel can never
 * again disagree with the dot. This drops dismissed/muted/applied, legacy
 * info/registry-proposal findings, and -- the reason the panel used to cry wolf
 * -- the info/warn "reviewed" changes the AI logged that don't touch CCC
 * (managed-only settings like `enforceAvailableModels`, and the
 * `ANTHROPIC_DEFAULT_*_MODEL` env vars CCC never sets). Null snap -> [].
 */
export function selectBreakingFindings(
  snap: SentinelStateSnapshot | null,
  ctx: ReachabilityContext = {},
): SentinelFinding[] {
  return (snap?.findings ?? []).filter((f) => f.status === 'open' && findingReachesUser(f, ctx))
}

/** One finding as copyable plain text: title (+ surface), what breaks, evidence.
 *  The prefix reads the severity (2026-09-02): only 'high' is a severe break;
 *  'warn' findings (the model-coverage arm) are compatibility notices, and the
 *  copyable text must not shout [BREAKING] about a model that breaks nothing. */
export function formatFindingText(finding: SentinelFinding): string {
  const sfc = surfaceLabel(finding.surface)
  const prefix = finding.severity === 'high' ? '[BREAKING]' : '[NOTICE]'
  const lines = [`${prefix} ${finding.title}${sfc ? ` (${sfc})` : ''}`]
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
  const out: string[] = ['Sentinel: Breaking Changes', `CC ${version} · ${when}`, '']
  if (breaking.length === 0) {
    out.push(`No breaking changes. Claude Code ${version} is compatible.`)
  } else {
    for (const f of breaking) out.push(formatFindingText(f), '')
  }
  return out.join('\n').trim() + '\n'
}
