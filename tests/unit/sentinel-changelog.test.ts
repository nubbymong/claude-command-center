import { describe, it, expect } from 'vitest'
import { sliceChangelog } from '../../src/main/sentinel/sentinel-changelog'

const md = `# Changelog\n\n## 2.1.0\n- Hooks now require matcher-wrapped arrays\n\n## 2.0.14\n- Fix foo\n\n## 2.0.13\n- Old entry\n`

describe('sliceChangelog', () => {
  it('returns entries newer than lastSeen up to and including current', () => {
    const s = sliceChangelog(md, '2.0.13', '2.1.0')
    expect(s).toContain('## 2.1.0'); expect(s).toContain('## 2.0.14'); expect(s).not.toContain('Old entry')
  })
  it('unknown versions -> whole changelog head, capped', () => {
    expect(sliceChangelog(md, '9.9.9', '9.9.10').length).toBeGreaterThan(0)
  })
  it('versions with v prefix in headings are handled', () => {
    const md2 = '## v2.1.0\n- New\n\n## v2.0.13\n- Old\n'
    const s = sliceChangelog(md2, '2.0.13', '2.1.0')
    expect(s).toContain('v2.1.0'); expect(s).not.toContain('Old')
  })
})
