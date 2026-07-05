import { describe, it, expect } from 'vitest'
import {
  selectBreakingFindings,
  surfaceLabel,
  formatFindingText,
  formatSentinelReportText,
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
    expect(text).toContain('CCC Sentinel')
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
    expect(formatSentinelReportText(null)).toContain('CCC Sentinel')
  })
})
