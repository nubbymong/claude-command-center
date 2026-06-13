import { describe, it, expect } from 'vitest'
import {
  selectSentinelSections,
  formatFindingText,
  formatSentinelReportText,
} from '../../../src/renderer/components/sentinel/sentinel-report-text'
import type { SentinelFinding, SentinelStateSnapshot } from '../../../src/shared/sentinel-types'

function finding(over: Partial<SentinelFinding> = {}): SentinelFinding {
  return {
    id: over.id ?? 'cc:2.1.177:1',
    kind: over.kind ?? 'compat',
    severity: over.severity ?? 'warn',
    title: over.title ?? 'enforceAvailableModels constrains --model flag resolution',
    evidence: over.evidence ?? 'Added `enforceAvailableModels` managed setting',
    affectedFeature: over.affectedFeature,
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

describe('selectSentinelSections', () => {
  it('splits open findings into proposals / compat / applied, excluding dismissed + muted', () => {
    const findings: SentinelFinding[] = [
      finding({ id: 'p1', kind: 'registry-proposal', status: 'open' }),
      finding({ id: 'c1', kind: 'compat', status: 'open' }),
      finding({ id: 'i1', kind: 'info', status: 'open' }),
      finding({ id: 'a1', kind: 'compat', status: 'applied' }),
      finding({ id: 'm1', kind: 'compat', status: 'muted' }),
      finding({ id: 'd1', kind: 'info', status: 'dismissed' }),
    ]
    const out = selectSentinelSections(snap({ findings }))
    expect(out.proposals.map((f) => f.id)).toEqual(['p1'])
    expect(out.compatFindings.map((f) => f.id)).toEqual(['c1', 'i1'])
    expect(out.applied.map((f) => f.id)).toEqual(['a1'])
  })

  it('returns empty arrays for a null snapshot', () => {
    expect(selectSentinelSections(null)).toEqual({ proposals: [], compatFindings: [], applied: [] })
  })
})

describe('formatFindingText', () => {
  it('renders severity, title, affected feature and evidence', () => {
    const text = formatFindingText(finding({ affectedFeature: 'sessions' }))
    expect(text).toBe(
      '[WARN] enforceAvailableModels constrains --model flag resolution (sessions)\n' +
        'Added `enforceAvailableModels` managed setting',
    )
  })

  it('omits the feature parenthetical when there is no affected feature', () => {
    const text = formatFindingText(finding({ affectedFeature: undefined }))
    expect(text.startsWith('[WARN] enforceAvailableModels constrains --model flag resolution\n')).toBe(true)
    expect(text).not.toContain('()')
  })

  it('appends the proposed patch JSON for a proposal finding', () => {
    const text = formatFindingText(
      finding({ kind: 'registry-proposal', proposedPatch: { id: 'claude-x', displayName: 'Claude X' } as never }),
    )
    expect(text).toContain('"id": "claude-x"')
  })
})

describe('formatSentinelReportText', () => {
  it('includes the CC version header and only the non-empty sections', () => {
    const findings: SentinelFinding[] = [
      finding({ id: 'c1', kind: 'compat', title: 'Compat one', evidence: 'ev one' }),
      finding({ id: 'i1', kind: 'info', severity: 'info', title: 'Info two', evidence: 'ev two' }),
    ]
    const text = formatSentinelReportText(snap({ findings }))
    expect(text).toContain('CCC Sentinel')
    expect(text).toContain('CC 2.1.177')
    expect(text).toContain(new Date(1700000000000).toISOString())
    expect(text).toContain('Compatibility report')
    expect(text).toContain('[WARN] Compat one')
    expect(text).toContain('[INFO] Info two')
    // no empty sections
    expect(text).not.toContain('Proposed fixes')
    expect(text).not.toContain('Applied')
  })

  it('renders a clean "no findings" line when there is nothing open', () => {
    const text = formatSentinelReportText(snap({ findings: [] }))
    expect(text).toContain('No findings')
  })

  it('handles a null snapshot without throwing', () => {
    expect(() => formatSentinelReportText(null)).not.toThrow()
    expect(formatSentinelReportText(null)).toContain('CCC Sentinel')
  })
})
