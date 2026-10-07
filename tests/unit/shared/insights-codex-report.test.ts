// [host] WP2 PR 4, P4.7 (row 68): the one rule for a stored Codex report
// (report.json), used by main before anything is kept and by the page before
// anything is drawn. A report that does not check is no report: the page
// then shows "No report available", never anything it was not checked to be.
import { describe, it, expect } from 'vitest'
import {
  CODEX_REPORT_VERSION,
  codexReportText,
  parseCodexStoredReport,
  readCodexStoredReport,
} from '../../../src/shared/insights-codex-report'

const report = (sections: unknown[], over: Record<string, unknown> = {}) => ({
  version: CODEX_REPORT_VERSION,
  title: 'Codex Insights',
  subtitle: '128 turns across 23 sessions | 2026-09-12 to 2026-10-02',
  sections,
  ...over,
})
const GLANCE = { kind: 'at-a-glance', title: 'At a glance', body: "What's working: a\nWhat's hindering you: b\nQuick win to try: c" }
const NARRATIVE = { kind: 'narrative', title: 'How you use Codex', paragraphs: ['One.', 'Two.'] }

describe('a stored Codex report', () => {
  it('reads the seven card kinds back, in the order the page draws them [host]', () => {
    const r = readCodexStoredReport(report([
      { kind: 'horizon', title: 'On the horizon', body: 'h' },
      { kind: 'patterns', items: [{ title: 'p', summary: 's', detail: 'd' }] },
      { kind: 'features', items: [{ title: 'f', oneliner: 'o', why: 'w' }] },
      { kind: 'friction', items: [{ title: 'x', desc: 'y' }] },
      { kind: 'big-wins', items: [{ title: 'w', desc: 'd' }] },
      NARRATIVE,
      GLANCE,
    ]))
    expect(r?.sections.map((s) => s.kind)).toEqual(['at-a-glance', 'narrative', 'big-wins', 'friction', 'features', 'patterns', 'horizon'])
    expect((r?.sections[0] as { body: string }).body.split('\n')).toHaveLength(3)
  })

  it('is no report when its version, a card, or a field is not one this build reads [host]', () => {
    expect(readCodexStoredReport(report([GLANCE, NARRATIVE], { version: 2 }))).toBeNull()
    expect(readCodexStoredReport(report([GLANCE]))).toBeNull()
    expect(readCodexStoredReport(report([NARRATIVE]))).toBeNull()
    expect(readCodexStoredReport(report([GLANCE, NARRATIVE, { kind: 'raw-html', html: '<b>x</b>' }]))).toBeNull()
    expect(readCodexStoredReport(report([GLANCE, NARRATIVE, GLANCE]))).toBeNull()
    expect(readCodexStoredReport(report([GLANCE, { ...NARRATIVE, paragraphs: [1] }]))).toBeNull()
    expect(readCodexStoredReport(report([GLANCE, NARRATIVE, { kind: 'big-wins', items: [] }]))).toBeNull()
    expect(readCodexStoredReport(report([GLANCE, NARRATIVE, { kind: 'big-wins', items: Array.from({ length: 7 }, () => ({ title: 't', desc: 'd' })) }]))).toBeNull()
    expect(readCodexStoredReport(report([GLANCE, NARRATIVE], { title: '' }))).toBeNull()
    expect(readCodexStoredReport(null)).toBeNull()
    expect(readCodexStoredReport([GLANCE])).toBeNull()
  })

  it("a file that is not JSON, or too large, is no report; parse never throws [host]", () => {
    expect(parseCodexStoredReport('<html>')).toBeNull()
    expect(parseCodexStoredReport(undefined)).toBeNull()
    expect(parseCodexStoredReport('x'.repeat(600 * 1024))).toBeNull()
    expect(parseCodexStoredReport(JSON.stringify(report([GLANCE, NARRATIVE])))?.title).toBe('Codex Insights')
  })

  it('every field is plain text: controls, bidi and invisible characters replaced, cut to its length [host]', () => {
    const r = readCodexStoredReport(report([GLANCE, { ...NARRATIVE, paragraphs: [`a\u202eb\u0000c\u200bd ${'x'.repeat(5000)}`] }]))
    const p = (r?.sections[1] as { paragraphs: string[] }).paragraphs[0]
    expect(p.startsWith('a b c d')).toBe(true)
    expect(Array.from(p).length).toBeLessThanOrEqual(1200)
    expect(p.endsWith('...')).toBe(true)
    expect(codexReportText(42)).toBeNull()
    expect(codexReportText('  a \n\t b  ')).toBe('a b')
  })
})
