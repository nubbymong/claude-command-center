import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const h = vi.hoisted(() => ({ resourcesDir: '' }))
vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.resourcesDir,
  registerSetupHandlers: () => {}
}))

import { INSIGHTS_KPIS_MAX_BYTES, getInsightsKpis, getInsightsReport, isValidRunId, loadPreviousKpis } from '../../src/main/insights-runner'

// Run ids are renderer-supplied and used as a PATH COMPONENT under the insights
// directory. A charset allowlist is used rather than a shape-specific regex
// because the id format has already changed once, so a strict shape would break
// reading older archives.

describe('isValidRunId', () => {
  it('accepts both archived run-id formats', () => {
    expect(isValidRunId('2026-02-06-143022')).toBe(true)        // older archives
    expect(isValidRunId('2026-08-03-123814-975001')).toBe(true) // current
  })

  it('rejects every separator a path could be built from', () => {
    for (const bad of [
      '..',
      '../x',
      '..\\x',
      'a/b',
      'a\\b',
      './x',
      'x/../../y',
      '%2e%2e/x',
      'C:\\Windows',
      '/etc',
      '\\\\server\\share'
    ]) {
      expect(isValidRunId(bad), bad).toBe(false)
    }
  })

  it('rejects empty, over-long, and non-string ids', () => {
    expect(isValidRunId('')).toBe(false)
    expect(isValidRunId('a'.repeat(129))).toBe(false)
    expect(isValidRunId(undefined)).toBe(false)
    expect(isValidRunId(null)).toBe(false)
    expect(isValidRunId(42)).toBe(false)
    expect(isValidRunId({ toString: () => 'ok' })).toBe(false)
  })
})

describe('the readers refuse a traversing id', () => {
  let root = ''
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runid-guard-'))
    h.resourcesDir = join(root, 'resources')
    // A file OUTSIDE the insights dir, at the exact relative location a traversing
    // id would resolve to. Reachable before the guard; unreachable after.
    const outside = join(h.resourcesDir, 'elsewhere')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'report.html'), 'SHOULD-NOT-BE-READABLE')
    writeFileSync(join(outside, 'kpis.json'), '{"secret":true}')
    // And a legitimate run, to prove the guard does not break the happy path.
    const good = join(h.resourcesDir, 'insights', '2026-08-03-123814-975001')
    mkdirSync(good, { recursive: true })
    writeFileSync(join(good, 'report.html'), 'LEGITIMATE')
    writeFileSync(join(good, 'kpis.json'), '{"ok":1}')
  })
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('still reads a legitimate run', () => {
    expect(getInsightsReport('2026-08-03-123814-975001')).toBe('LEGITIMATE')
    expect(getInsightsKpis('2026-08-03-123814-975001')).toEqual({ ok: 1 })
  })

  it('returns null for a relative-traversal id instead of the file outside', () => {
    for (const bad of ['../elsewhere', '..\\elsewhere', 'x/../../elsewhere']) {
      expect(getInsightsReport(bad), bad).toBeNull()
      expect(getInsightsKpis(bad), bad).toBeNull()
    }
  })
})

// The previous-run comparison reads only a run inside the insights folder:
// a catalogue entry whose id is not a run's own name is never the previous
// run, and it never hides a good older one.
describe('the previous-run comparison reads only a run inside the insights folder', () => {
  let root = ''
  let insights = ''
  const GOOD = '2026-08-03-123814-975001'
  const CURRENT = '2026-08-10-090000-000001'
  const GOOD_KPIS = '{"from":"the good older run"}'
  /** The catalogue: the good older run, `entries` after it, then the run in flight. */
  function catalogue(...entries: Array<{ id: unknown; status?: string }>): void {
    const runs = [
      { id: GOOD, timestamp: 1, status: 'complete' },
      ...entries.map((e, i) => ({ timestamp: 2 + i, status: 'complete', ...e })),
      { id: CURRENT, timestamp: 99, status: 'running' }
    ]
    writeFileSync(join(insights, 'catalogue.json'), JSON.stringify({ runs }))
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'runid-prev-'))
    h.resourcesDir = join(root, 'resources')
    insights = join(h.resourcesDir, 'insights')
    mkdirSync(join(insights, GOOD), { recursive: true })
    writeFileSync(join(insights, GOOD, 'kpis.json'), GOOD_KPIS)
  })
  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('a valid id: its own kpis.json', () => {
    catalogue()
    expect(loadPreviousKpis(CURRENT)).toBe(GOOD_KPIS)
  })

  it('a newer entry whose id is not a run name is skipped, and the good older run is still found', () => {
    const bad = ['../outside', '..\\outside', 'a/b', '.', join(root, 'abs-outside'), 'x'.repeat(129), '', 42, null]
    for (const id of bad) {
      // A kpis.json where joining the entry's id under insights would land (where a folder can be made there).
      if (typeof id === 'string' && id !== '') {
        const at = join(insights, id, 'kpis.json')
        try { mkdirSync(dirname(at), { recursive: true }); writeFileSync(at, `{"from":${JSON.stringify(String(id))}}`) } catch { /* not a path this platform can make */ }
      }
      catalogue({ id })
      expect(loadPreviousKpis(CURRENT), String(id)).toBe(GOOD_KPIS)
    }
  })

  it("a previous run's kpis.json past its size limit is not read into the comparison", () => {
    catalogue()
    writeFileSync(join(insights, GOOD, 'kpis.json'), JSON.stringify({ pad: 'y'.repeat(INSIGHTS_KPIS_MAX_BYTES) }))
    expect(loadPreviousKpis(CURRENT)).toBeNull()
  })
})
