// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { parseInsightsReport, parseCodexInsightsReport } from '../../../src/renderer/components/insights/parseInsightsReport'

const SAMPLE = `<!DOCTYPE html><html><body>
  <h1>Title</h1>
  <p class="subtitle">Sub</p>
  <section class="at-a-glance"><h2>Glance</h2><div class="glance-section">Body</div></section>
  <section class="narrative"><h2>Narrative</h2><p>Para 1</p></section>
  <section class="big-wins"><div class="big-win"><div class="big-win-title">W1</div><div class="big-win-desc">D1</div></div></section>
</body></html>`

describe('parseInsightsReport (U3.1)', () => {
  it('extracts title + subtitle', () => {
    const r = parseInsightsReport(SAMPLE)
    expect(r.title).toBe('Title')
    expect(r.subtitle).toBe('Sub')
  })
  it('extracts at-a-glance + narrative as named sections', () => {
    const r = parseInsightsReport(SAMPLE)
    expect(r.sections.find(s => s.kind === 'at-a-glance')).toBeTruthy()
    expect(r.sections.find(s => s.kind === 'narrative')).toBeTruthy()
  })
  it('extracts big-wins entries', () => {
    const r = parseInsightsReport(SAMPLE)
    const wins = r.sections.find(s => s.kind === 'big-wins') as any
    expect(wins.items[0].title).toBe('W1')
    expect(wins.items[0].desc).toBe('D1')
  })
  it('handles missing sections gracefully', () => {
    const r = parseInsightsReport('<html><body></body></html>')
    expect(r.title).toBe('')
    expect(r.sections).toEqual([])
  })
})

// [host] WP2 PR 4, P4.7 (row 68): a Codex report is data (report.json), read
// by the one rule main wrote it with; never parsed as HTML.
describe('parseCodexInsightsReport', () => {
  const stored = (sections: unknown[]) => JSON.stringify({ version: 1, title: 'Codex Insights', subtitle: '3 turns across 2 sessions', sections })
  const GLANCE = { kind: 'at-a-glance', title: 'At a glance', body: "What's working: a" }
  const NARRATIVE = { kind: 'narrative', title: 'How you use Codex', paragraphs: ['p'] }

  it("reads a stored report into the same cards as Claude's [host]", () => {
    const r = parseCodexInsightsReport(stored([GLANCE, NARRATIVE]))
    expect(r).toEqual({ title: 'Codex Insights', subtitle: '3 turns across 2 sessions', sections: [GLANCE, NARRATIVE] })
  })

  it('HTML, a card kind it does not know, or nothing, is no report [host]', () => {
    expect(parseCodexInsightsReport('<html><h1>Codex Insights</h1></html>')).toBeNull()
    expect(parseCodexInsightsReport(stored([GLANCE, NARRATIVE, { kind: 'raw', html: '<b>' }]))).toBeNull()
    expect(parseCodexInsightsReport(null)).toBeNull()
  })
})
