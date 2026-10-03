import { describe, it, expect } from 'vitest'
import {
  selectBreakingFindings,
  surfaceLabel,
  formatFindingText,
  formatSentinelReportText,
  sentinelAnalyzingText,
  sentinelSettingsText,
  sentinelTransparencyText,
  sentinelWatchedNames,
} from '../../../src/renderer/components/sentinel/sentinel-report-text'
import type { SentinelFinding, SentinelStateSnapshot } from '../../../src/shared/sentinel-types'

function finding(over: Partial<SentinelFinding> = {}): SentinelFinding {
  return {
    id: over.id ?? 'cc:2.1.177:1',
    kind: over.kind ?? 'compat',
    severity: over.severity ?? 'high',
    title: over.title ?? 'Session spawn flag renamed',
    evidence: over.evidence ?? 'Renamed --print to --headless',
    affectedFeature: over.affectedFeature,
    badgeText: over.badgeText,
    surface: over.surface,
    proposedPatch: over.proposedPatch,
    status: over.status ?? 'open',
    createdAt: over.createdAt ?? 1,
  }
}

const snap = (over: Partial<SentinelStateSnapshot> = {}): SentinelStateSnapshot => ({
  lastSeenCcVersion: over.lastSeenCcVersion ?? '2.1.177',
  analyzing: over.analyzing ?? false,
  lastAnalysisAt: over.lastAnalysisAt ?? 1700000000000,
  lastAnalysisError: over.lastAnalysisError ?? null,
  findings: over.findings ?? [],
})

describe('surfaceLabel', () => {
  it('maps 1-4 to human labels, null otherwise', () => {
    expect(surfaceLabel(1)).toBe('session launch')
    expect(surfaceLabel(3)).toBe('statusline hook')
    expect(surfaceLabel(undefined)).toBeNull()
    expect(surfaceLabel(9)).toBeNull()
  })
})

describe('selectBreakingFindings', () => {
  it('keeps only open compat findings; drops muted/dismissed/applied and legacy info/proposal', () => {
    const findings: SentinelFinding[] = [
      finding({ id: 'b1', kind: 'compat', status: 'open' }),
      finding({ id: 'b2', kind: 'compat', status: 'open' }),
      finding({ id: 'i1', kind: 'info', status: 'open' }),               // legacy info: excluded
      finding({ id: 'p1', kind: 'registry-proposal', status: 'open' }),  // legacy proposal: excluded
      finding({ id: 'm1', kind: 'compat', status: 'muted' }),
      finding({ id: 'a1', kind: 'compat', status: 'applied' }),
      finding({ id: 'd1', kind: 'compat', status: 'dismissed' }),
    ]
    expect(selectBreakingFindings(snap({ findings })).map((f) => f.id)).toEqual(['b1', 'b2'])
  })

  it('drops findings that do not reach this install: compat/info, managed-only, and unused model-env', () => {
    // The exact shapes that leaked into the panel as "[BREAKING]" before the
    // reachability gate: legacy info-severity compat findings, and warn findings
    // about managed-only settings / ANTHROPIC_DEFAULT_*_MODEL env vars CCC never
    // sets. Only the genuinely reaching high finding survives.
    const findings: SentinelFinding[] = [
      finding({ id: 'real', severity: 'high', title: 'Statusline stdin fields renamed', evidence: 'model.id removed from the statusline JSON' }),
      finding({ id: 'ci', kind: 'compat', severity: 'info', title: 'New sandbox.credentials key', evidence: 'Added sandbox.credentials setting' }),
      finding({ id: 'managed', kind: 'compat', severity: 'warn', title: 'enforceAvailableModels constrains --model', evidence: 'Added enforceAvailableModels managed setting' }),
      finding({ id: 'env', kind: 'compat', severity: 'warn', title: 'ANTHROPIC_DEFAULT_*_MODEL blocked', evidence: 'alias picks can no longer be redirected via ANTHROPIC_DEFAULT_*_MODEL env vars' }),
    ]
    expect(selectBreakingFindings(snap({ findings })).map((f) => f.id)).toEqual(['real'])
  })

  it('returns [] for a null snapshot', () => {
    expect(selectBreakingFindings(null)).toEqual([])
  })
})

describe('formatFindingText', () => {
  it('renders [BREAKING], title with surface, what-breaks, and evidence', () => {
    const text = formatFindingText(finding({ surface: 1, badgeText: 'CCC sessions will not start' }))
    expect(text).toBe(
      '[BREAKING] Session spawn flag renamed (session launch)\n' +
        'CCC sessions will not start\n' +
        'Renamed --print to --headless',
    )
  })

  it('omits the surface parenthetical when there is no surface', () => {
    const text = formatFindingText(finding({ surface: undefined, badgeText: undefined }))
    expect(text.startsWith('[BREAKING] Session spawn flag renamed\n')).toBe(true)
    expect(text).not.toContain('()')
  })
})

describe('formatSentinelReportText', () => {
  it('includes the CC version header and each breaking change', () => {
    const findings: SentinelFinding[] = [
      finding({ id: 'b1', title: 'Hooks contract changed', surface: 3, evidence: 'ev one' }),
    ]
    const text = formatSentinelReportText(snap({ findings }))
    expect(text).toContain('Sentinel: Breaking Changes')
    expect(text).toContain('CC 2.1.177')
    expect(text).toContain(new Date(1700000000000).toISOString())
    expect(text).toContain('[BREAKING] Hooks contract changed (statusline hook)')
  })

  it('renders a clean all-clear line when nothing is breaking', () => {
    const text = formatSentinelReportText(snap({ findings: [] }))
    expect(text).toContain('No breaking changes')
  })

  it('handles a null snapshot without throwing', () => {
    expect(() => formatSentinelReportText(null)).not.toThrow()
    expect(formatSentinelReportText(null)).toContain('Sentinel: Breaking Changes')
  })
})

// P3.9 (row 42): Sentinel watches each assistant in use. The version line,
// the all-clear and the wording of what it watches and spends name only the
// assistants in use; Claude Code alone reads exactly as before.
describe('Sentinel for Codex: the lines that name the assistants (P3.9)', () => {
  const both = { claudeOn: true, codexOn: true }
  const codexOnly = { claudeOn: false, codexOn: true }
  const claudeOnly = { claudeOn: true, codexOn: false }
  const s = snap({ findings: [] })
  const withCodex: SentinelStateSnapshot = { ...s, lastSeenCodexVersion: '0.155.1' }

  it("a Codex surface 3 is its session files, not Claude's statusline hook", () => {
    expect(surfaceLabel(3, 'codex')).toBe('session files')
    expect(surfaceLabel(1, 'codex')).toBe('session launch')
    expect(surfaceLabel(3)).toBe('statusline hook')
    expect(surfaceLabel(3, 'claude')).toBe('statusline hook')
    expect(surfaceLabel(undefined, 'codex')).toBeNull()
  })

  it("a Codex finding's copy says it is Codex's; Claude's copy is unchanged", () => {
    const codex = { ...finding({ surface: 3, badgeText: 'status line readouts die' }), provider: 'codex' as const }
    expect(formatFindingText(codex).split('\n')[0]).toBe('[BREAKING] Session spawn flag renamed (Codex, session files)')
    const noSurface = { ...finding({ severity: 'warn', surface: undefined }), provider: 'codex' as const }
    expect(formatFindingText(noSurface).split('\n')[0]).toBe('[NOTICE] Session spawn flag renamed (Codex)')
    expect(formatFindingText(finding({ surface: 3 })).split('\n')[0]).toBe('[BREAKING] Session spawn flag renamed (statusline hook)')
  })

  it('the report names the version of each assistant in use, and the all-clear names them', () => {
    const at = new Date(1700000000000).toISOString()
    expect(formatSentinelReportText(withCodex).split('\n').slice(0, 4)).toEqual(['Sentinel: Breaking Changes', `CC 2.1.177 \u00b7 ${at}`, '', 'No breaking changes. Claude Code 2.1.177 is compatible.'])
    expect(formatSentinelReportText(withCodex, claudeOnly)).toBe(formatSentinelReportText(withCodex))
    expect(formatSentinelReportText(withCodex, both).split('\n').slice(1, 4)).toEqual([`CC 2.1.177 \u00b7 Codex 0.155.1 \u00b7 ${at}`, '', 'No breaking changes. Claude Code 2.1.177 and Codex 0.155.1 are compatible.'])
    expect(formatSentinelReportText(withCodex, codexOnly).split('\n').slice(1, 4)).toEqual([`Codex 0.155.1 \u00b7 ${at}`, '', 'No breaking changes. Codex 0.155.1 is compatible.'])
    expect(formatSentinelReportText(s, codexOnly)).toContain('Codex unknown')
    // Neither in use (a state setup never leaves) reads as Claude Code alone.
    expect(formatSentinelReportText(withCodex, { claudeOn: false, codexOn: false })).toBe(formatSentinelReportText(withCodex))
  })

  it('while an analysis runs, the line says whose update it is', () => {
    expect(sentinelAnalyzingText({ ...s, analyzing: true, analyzingProvider: 'codex' })).toBe('Analyzing the Codex update... this can take a few minutes.')
    expect(sentinelAnalyzingText({ ...s, analyzing: true, analyzingProvider: 'claude' })).toBe('Analyzing the Claude Code update\u2026 this can take a few minutes.')
    expect(sentinelAnalyzingText({ ...s, analyzing: true })).toBe('Analyzing the Claude Code update\u2026 this can take a few minutes.')
  })

  it('Settings says what Sentinel watches and what its analysis spends; Claude Code alone reads as before', () => {
    expect(sentinelSettingsText(claudeOnly, 'claude')).toBe('Detects Claude Code updates and proposes registry fixes. Off by default because it spends Claude tokens on a Claude update. Takes effect after restart.')
    expect(sentinelSettingsText(codexOnly, 'codex')).toBe('Detects Codex updates and proposes registry fixes. Off by default because it spends Codex usage on a Codex update. Takes effect after restart.')
    expect(sentinelSettingsText(both, 'claude')).toBe('Detects Claude Code and Codex updates and proposes registry fixes. Off by default because its analysis spends Claude tokens on an update. Takes effect after restart.')
    expect(sentinelSettingsText(both, 'codex')).toBe('Detects Claude Code and Codex updates and proposes registry fixes. Off by default because its analysis spends Codex usage on an update. Takes effect after restart.')
  })

  it('the Transparency card says what Sentinel watches and runs on (left there by P3.4); Claude Code alone reads as before', () => {
    expect(sentinelTransparencyText(claudeOnly, 'claude')).toBe('Watches Claude Code updates for changes that could break your setup and proposes fixes. Off by default because it spends Claude tokens when Claude updates. Takes effect after a restart.')
    expect(sentinelTransparencyText(codexOnly, 'codex')).toBe('Watches Codex updates for changes that could break your setup and proposes fixes. Off by default because it spends Codex usage when Codex updates. Takes effect after a restart.')
    expect(sentinelTransparencyText(both, 'codex')).toBe('Watches Claude Code and Codex updates for changes that could break your setup and proposes fixes. Off by default because its analysis spends Codex usage when either updates. Takes effect after a restart.')
    for (const t of [sentinelTransparencyText(codexOnly, 'codex'), sentinelSettingsText(codexOnly, 'codex')]) expect(t).not.toMatch(/Claude/)
    expect(sentinelWatchedNames(both)).toBe('Claude Code and Codex')
  })
})
