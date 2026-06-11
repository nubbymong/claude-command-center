import { describe, it, expect } from 'vitest'
import { parseClaudeVersion, compareSemver, minVersionFindings } from '../../src/main/sentinel/sentinel-version'
import manifestJson from '../../resources/sentinel-assumption-manifest.json'

describe('parseClaudeVersion', () => {
  it.each([
    ['2.0.13 (Claude Code)', '2.0.13'],
    ['claude 2.1.0', '2.1.0'],
    ['2.1.0-beta.1', '2.1.0-beta.1'],
    ['garbage with no version', null],
  ])('%s -> %s', (raw, v) => expect(parseClaudeVersion(raw)).toBe(v))
})

describe('compareSemver', () => {
  it('orders correctly', () => {
    expect(compareSemver('2.0.13', '2.1.0')).toBeLessThan(0)
    expect(compareSemver('2.1.0', '2.1.0')).toBe(0)
    expect(compareSemver('2.10.0', '2.9.9')).toBeGreaterThan(0)
  })
})

describe('minVersionFindings', () => {
  const manifest = [{ id: 'x', area: 'a', contract: 'c', files: [], failureMode: 'f', severity: 'high',
    configFixable: false, affectedFeature: 'logs', minCcVersion: '2.5.0' }]
  it('older CC -> compat finding', () => {
    expect(minVersionFindings('2.4.0', manifest as never)).toHaveLength(1)
  })
  it('newer CC -> none', () => {
    expect(minVersionFindings('2.6.0', manifest as never)).toHaveLength(0)
  })
})

describe('shipped manifest', () => {
  it('parses, has >= 18 entries, every entry well-formed', () => {
    const m = manifestJson as Array<Record<string, unknown>>
    expect(m.length).toBeGreaterThanOrEqual(18)
    for (const e of m) {
      expect(typeof e.id).toBe('string')
      expect(typeof e.contract).toBe('string')
      expect(['info', 'warn', 'high']).toContain(e.severity)
      expect(typeof e.configFixable).toBe('boolean')
    }
  })
  it('ids are unique', () => {
    const ids = (manifestJson as Array<{ id: string }>).map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
