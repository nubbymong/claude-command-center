/**
 * Pure helpers for the Sentinel panel (severe-breaking-only): the open
 * breaking findings + plain-text rendering, so the panel's Copy buttons and the
 * rendered list share ONE definition of what is shown (copy can never drift from
 * the rendered report). Kept pure + framework-free so it is unit-tested without
 * rendering. No default export (project convention).
 *
 * P3.9: Sentinel watches each assistant in use (Claude Code, Codex or both),
 * so the version line, the all-clear line and the wording that says what it
 * watches and spends name the assistants in use (a provider that is off shows
 * nothing), and a Codex finding says it is Codex's.
 */
import type { SentinelFinding, SentinelProvider, SentinelStateSnapshot } from '../../../shared/sentinel-types'
import { findingReachesUser, type ReachabilityContext } from '../../../shared/sentinel-reachability'

const SURFACE_LABEL: Record<number, string> = {
  1: 'session launch',
  2: 'terminal embedding',
  3: 'statusline hook',
  4: 'config & account files',
}

/** Codex's four surfaces (P3.9): its session (rollout) files take the place
 *  of Claude Code's statusline hook. */
const CODEX_SURFACE_LABEL: Record<number, string> = {
  1: 'session launch',
  2: 'terminal embedding',
  3: 'session files',
  4: 'config & account files',
}

const SURFACES: Readonly<Record<SentinelProvider, Record<number, string>>> = { claude: SURFACE_LABEL, codex: CODEX_SURFACE_LABEL }

/** The tag a finding of each provider wears beside its surface: none for
 *  Claude Code's (as before), "Codex" for Codex's. */
const PROVIDER_TAG: Readonly<Record<SentinelProvider, string | null>> = { claude: null, codex: 'Codex' }

/** Human label for a breaking finding's CCC surface (1-4), or null. */
export function surfaceLabel(surface?: number, provider?: SentinelProvider): string | null {
  if (surface == null) return null
  const table = Object.hasOwn(SURFACES, provider ?? 'claude') ? SURFACES[provider ?? 'claude'] : SURFACE_LABEL
  return table[surface] ?? null
}

/** The provider tag a finding wears (P3.9), or null. */
export function providerTag(finding: Pick<SentinelFinding, 'provider'>): string | null {
  const p = finding.provider
  return p && Object.hasOwn(PROVIDER_TAG, p) ? PROVIDER_TAG[p] : null
}

/** Which assistants are in use, for the lines that name them (P3.9). */
export interface SentinelScope { claudeOn: boolean; codexOn: boolean }

/** Claude Code alone: every line reads as it did before Codex. */
export const CLAUDE_ONLY_SCOPE: SentinelScope = Object.freeze({ claudeOn: true, codexOn: false })

/** The scope as it can be shown: neither in use (a state setup never
 *  leaves) reads as Claude Code alone. */
function shown(scope: SentinelScope): SentinelScope {
  return scope.claudeOn || scope.codexOn ? scope : CLAUDE_ONLY_SCOPE
}

/** The separator the panel's subtitle and the report's header use. */
export const SENTINEL_SEPARATOR = ' \u00b7 '

/** Each assistant in use and the version Sentinel last saw of it. */
export function sentinelVersionParts(snap: SentinelStateSnapshot | null, scope: SentinelScope = CLAUDE_ONLY_SCOPE): string[] {
  const s = shown(scope)
  const out: string[] = []
  if (s.claudeOn) out.push(`CC ${snap?.lastSeenCcVersion ?? 'unknown'}`)
  if (s.codexOn) out.push(`Codex ${snap?.lastSeenCodexVersion ?? 'unknown'}`)
  return out
}

/** What the all-clear says is compatible: "Claude Code 2.1.0", "Codex
 *  0.155.1", or both joined; and whether that reads as plural. */
export function sentinelCompatibleSubject(snap: SentinelStateSnapshot | null, scope: SentinelScope = CLAUDE_ONLY_SCOPE): { text: string; plural: boolean } {
  const s = shown(scope)
  const names: string[] = []
  if (s.claudeOn) names.push(`Claude Code ${snap?.lastSeenCcVersion ?? 'unknown'}`)
  if (s.codexOn) names.push(`Codex ${snap?.lastSeenCodexVersion ?? 'unknown'}`)
  return { text: names.join(' and '), plural: names.length > 1 }
}

/** The line shown while an analysis runs: whose update it is. */
export function sentinelAnalyzingText(snap: SentinelStateSnapshot | null): string {
  return snap?.analyzingProvider === 'codex'
    ? 'Analyzing the Codex update... this can take a few minutes.'
    : 'Analyzing the Claude Code update\u2026 this can take a few minutes.'
}

/** The names of the assistants Sentinel watches. */
export function sentinelWatchedNames(scope: SentinelScope): string {
  const s = shown(scope)
  return s.claudeOn && s.codexOn ? 'Claude Code and Codex' : s.codexOn ? 'Codex' : 'Claude Code'
}

/** What an analysis spends, on the assistant it runs on. */
function spends(runsOn: SentinelProvider | null): string {
  return runsOn === 'codex' ? 'Codex usage' : 'Claude tokens'
}

/** Settings, Sentinel: the line under "Enable Sentinel". Claude Code alone
 *  reads exactly as before. */
export function sentinelSettingsText(scope: SentinelScope, runsOn: SentinelProvider | null): string {
  const s = shown(scope)
  if (s.claudeOn && !s.codexOn) return 'Detects Claude Code updates and proposes registry fixes. Off by default because it spends Claude tokens on a Claude update. Takes effect after restart.'
  if (!s.claudeOn) return 'Detects Codex updates and proposes registry fixes. Off by default because it spends Codex usage on a Codex update. Takes effect after restart.'
  return `Detects Claude Code and Codex updates and proposes registry fixes. Off by default because its analysis spends ${spends(runsOn)} on an update. Takes effect after restart.`
}

/** The onboarding Transparency page's Sentinel card: what it watches and
 *  runs on (P3.9, left there by P3.4). Claude Code alone reads as before. */
export function sentinelTransparencyText(scope: SentinelScope, runsOn: SentinelProvider | null): string {
  const s = shown(scope)
  if (s.claudeOn && !s.codexOn) return 'Watches Claude Code updates for changes that could break your setup and proposes fixes. Off by default because it spends Claude tokens when Claude updates. Takes effect after a restart.'
  if (!s.claudeOn) return 'Watches Codex updates for changes that could break your setup and proposes fixes. Off by default because it spends Codex usage when Codex updates. Takes effect after a restart.'
  return `Watches Claude Code and Codex updates for changes that could break your setup and proposes fixes. Off by default because its analysis spends ${spends(runsOn)} when either updates. Takes effect after a restart.`
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
 *  copyable text must not shout [BREAKING] about a model that breaks nothing.
 *  P3.9: a Codex finding says so beside its surface. */
export function formatFindingText(finding: SentinelFinding): string {
  const sfc = surfaceLabel(finding.surface, finding.provider)
  const prefix = finding.severity === 'high' ? '[BREAKING]' : '[NOTICE]'
  const tags = [providerTag(finding), sfc].filter((t): t is string => !!t)
  const lines = [`${prefix} ${finding.title}${tags.length ? ` (${tags.join(', ')})` : ''}`]
  if (finding.badgeText) lines.push(finding.badgeText)   // whatBreaks
  if (finding.evidence) lines.push(finding.evidence)
  return lines.join('\n')
}

/** The whole report as copyable plain text: header + each breaking change, or a
 *  clean all-clear line. `scope` (P3.9): the assistants in use. */
export function formatSentinelReportText(snap: SentinelStateSnapshot | null, scope: SentinelScope = CLAUDE_ONLY_SCOPE): string {
  const breaking = selectBreakingFindings(snap)
  const when = snap?.lastAnalysisAt ? new Date(snap.lastAnalysisAt).toISOString() : 'no analysis yet'
  const out: string[] = ['Sentinel: Breaking Changes', [...sentinelVersionParts(snap, scope), when].join(SENTINEL_SEPARATOR), '']
  if (breaking.length === 0) {
    const subject = sentinelCompatibleSubject(snap, scope)
    out.push(`No breaking changes. ${subject.text} ${subject.plural ? 'are' : 'is'} compatible.`)
  } else {
    for (const f of breaking) out.push(formatFindingText(f), '')
  }
  return out.join('\n').trim() + '\n'
}
