import { describe, it, expect } from 'vitest'
import { liveSessionsForProject } from '../../../src/renderer/components/memory/live-sessions'

const s = (over: object) => ({ id: 'a', name: 'n', workingDirectory: 'F:\\CLAUDE_MULTI_APP', sessionType: 'local', ...over })

describe('liveSessionsForProject', () => {
  it('matches local sessions whose cwd mangles to the projectDir', () => {
    expect(liveSessionsForProject([s({})], 'F--CLAUDE-MULTI-APP')).toHaveLength(1)
    expect(liveSessionsForProject([s({ workingDirectory: 'F:\\other' })], 'F--CLAUDE-MULTI-APP')).toHaveLength(0)
  })
  it('excludes ssh sessions and empty cwds', () => {
    expect(liveSessionsForProject([s({ sessionType: 'ssh' })], 'F--CLAUDE-MULTI-APP')).toHaveLength(0)
    expect(liveSessionsForProject([s({ workingDirectory: '' })], 'F--CLAUDE-MULTI-APP')).toHaveLength(0)
  })
})
