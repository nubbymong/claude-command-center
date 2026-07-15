import { describe, it, expect } from 'vitest'
import { liveSessionsForProject } from '../../../src/renderer/components/memory/live-sessions'

const s = (over: object) => ({ id: 'a', label: 'n', workingDirectory: 'F:\\MY_PROJECT', sessionType: 'local', ...over })

describe('liveSessionsForProject', () => {
  it('matches local sessions whose cwd mangles to the projectDir', () => {
    expect(liveSessionsForProject([s({})], 'F--MY-PROJECT')).toHaveLength(1)
    expect(liveSessionsForProject([s({ workingDirectory: 'F:\\other' })], 'F--MY-PROJECT')).toHaveLength(0)
  })
  it('excludes ssh sessions and empty cwds', () => {
    expect(liveSessionsForProject([s({ sessionType: 'ssh' })], 'F--MY-PROJECT')).toHaveLength(0)
    expect(liveSessionsForProject([s({ workingDirectory: '' })], 'F--MY-PROJECT')).toHaveLength(0)
  })
})
