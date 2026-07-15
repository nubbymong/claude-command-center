import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import { usageDataDir, claudeReportPath, claudeFacetsDir } from '../../src/main/insights-runner'

describe('insights account-home paths', () => {
  it('resolves report/facets against the account fake HOME when provided', () => {
    const home = join('C:', 'r', 'account-profiles', 'p1')
    expect(usageDataDir(home)).toBe(join(home, '.claude', 'usage-data'))
    expect(claudeReportPath(home)).toBe(join(home, '.claude', 'usage-data', 'report.html'))
    expect(claudeFacetsDir(home)).toBe(join(home, '.claude', 'usage-data', 'facets'))
  })

  it('falls back to the real home for the default account (home null)', () => {
    expect(claudeReportPath(null)).toBe(join(homedir(), '.claude', 'usage-data', 'report.html'))
    expect(claudeFacetsDir(null)).toBe(join(homedir(), '.claude', 'usage-data', 'facets'))
  })
})
